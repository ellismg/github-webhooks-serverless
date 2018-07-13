// Copyright 2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as GitHubApi from "@octokit/rest";
import * as serverless from  "@pulumi/aws-serverless";
import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import { RandomResource } from "./random";

const ghToken = new pulumi.Config("github").require("token");

class GithubWebhookProvider implements dynamic.ResourceProvider {
    check = (olds: any, news: any) => {
        const failedChecks: dynamic.CheckFailure[] = [];

        if (news["url"] === undefined) {
            failedChecks.push({property: "url", reason: "required property 'url' missing"});
        }

        if (news["org"] !== undefined && (news["owner"] !== undefined || news["repo"] !== undefined)) {
            failedChecks.push({property: "org", reason: "when 'org' is set, 'owner' and 'repo' must not be"});
        }

        if (news["owner"] !== undefined && news["repo"] === undefined) {
            failedChecks.push({property: "repo", reason: "when 'owner' is set, 'repo' must be as well"});
        }

        if (news["repo"] !== undefined && news["owner"] === undefined) {
            failedChecks.push({property: "owner", reason: "when 'repo' is set, 'owner' must be as well"});
        }

        return Promise.resolve({ inputs: news, failedChecks: failedChecks });
    }

    diff = (id: pulumi.ID, olds: any, news: any) => {
        const replaces: string[] = [];

        for (const prop of ["owner", "repo"]) {
            if (olds[prop] !== news[prop]) {
                replaces.push(prop);
            }
        }

        if (olds["org"] !== news["org"]) {
            replaces.push("org");
        }

        return Promise.resolve({replaces: replaces});
    }

    create = async (inputs: any) => {
        const octokit: GitHubApi = require("@octokit/rest")();
        octokit.authenticate({
            type: "token",
            token: ghToken,
        });

        const commonParams = {
            name: "web",
            events: inputs["events"],
            config: {
                content_type: "json",
                url: inputs["url"],
                secret: inputs["secret"],
            },
        };

        let res: GitHubApi.AnyResponse;
        if (inputs["org"]) {
            res = await octokit.orgs.createHook({
                org: inputs["org"],
                ...commonParams,
            });
        } else {
            res = await octokit.repos.createHook({
                owner: inputs["owner"],
                repo: inputs["repo"],
                ...commonParams,
            });
        }

        if (res.status !== 201) {
            throw new Error(`bad response: ${JSON.stringify(res)}`);
        }

        return {
            id: `${res.data["id"]}`,
        };
    }

    update = async (id: string, olds: any, news: any) => {
        const octokit: GitHubApi = require("@octokit/rest")();
        octokit.authenticate({
            type: "token",
            token: ghToken,
        });

        // the id property of GitHubApi.ReposEditHookParams has been deprecated but the
        // typescript definitions still mark it as required. Setting it causes a deprecation
        // warning at runtime, however, so we cast to ignore the error.
        const res = await octokit.repos.editHook(<GitHubApi.ReposEditHookParams>{
            hook_id: id,
            owner: news["owner"],
            repo: news["repo"],
            events: news["events"],
            config: {
                content_type: "json",
                url: news["url"],
            },
        });

        return {
            outs: {
                id: res.data.id,
            },
        };
    }

    delete = async (id: pulumi.ID, props: any) => {
        const octokit: GitHubApi = require("@octokit/rest")();

        octokit.authenticate({
            type: "token",
            token: ghToken,
        });

        let res: GitHubApi.AnyResponse;

        // the id property of GitHubApi.ReposDeleteHookParams has been deprecated but the
        // typescript definitions still mark it as required. Setting it causes a deprecation
        // warning at runtime, however, so we cast to ignore the error.
        if (props["org"]) {
            res = await octokit.orgs.deleteHook(<GitHubApi.OrgsDeleteHookParams>{
                hook_id: id,
                org: props["org"],
            });
        } else {
            res = await octokit.repos.deleteHook(<GitHubApi.ReposDeleteHookParams>{
                hook_id: id,
                owner: props["owner"],
                repo: props["repo"],
            });
        }

        if (res.status !== 204) {
            throw new Error(`bad response: ${JSON.stringify(res)}`);
        }
    }
}

interface GitHubWebhookResourceArgs {
    url: pulumi.Input<string>;
    owner?: pulumi.Input<string>;
    repo?: pulumi.Input<string>;
    org?: pulumi.Input<string>;
    events: pulumi.Input<string[]>;
    secret?: pulumi.Input<string>;
}

class GitHubWebhookResource extends dynamic.Resource {
    constructor(name: string, args: GitHubWebhookResourceArgs, opts?: pulumi.ResourceOptions) {
        super(new GithubWebhookProvider(), name, args, opts);
    }
}

export interface GitHubRepository {
    owner: string;
    repo: string;
}

export interface GitHubWebhookRequest {
    request: serverless.apigateway.Request;
    type: string;
    id: string;
    data: any;
}

export interface GitHubWebhookArgs {
    repositories?: GitHubRepository[];
    organizations?: string[];
    handler: (req: GitHubWebhookRequest) => Promise<void>;
    events: string[];
}

export class GitHubWebhook extends pulumi.ComponentResource {
    public readonly url: pulumi.Output<string>;

    constructor(name: string, args: GitHubWebhookArgs, opts?: pulumi.ResourceOptions) {
        if (args.organizations === undefined && args.repositories === undefined) {
            throw new Error("at least one organization or repository must be specified");
        }

        super("github:rest:Hook", name, {}, opts);

        const secret = new RandomResource(`${name}-secret`, 32, {
            parent: this,
        });

        const api = new serverless.apigateway.API("hook", {
            routes: [
                {
                    path: "/",
                    method: "POST",
                    handler: async (req) => {
                        const eventType = req.headers["X-GitHub-Event"];
                        const eventId = req.headers["X-GitHub-Delivery"];
                        const eventSig = req.headers["X-Hub-Signature"];

                        if (!(eventType && eventId && eventSig && req.body)) {
                            return {
                                statusCode: 400,
                                body: "missing parameter",
                            };
                        }

                        const body = Buffer.from(req.body, req.isBase64Encoded ? "base64" : "utf8");

                        const crypto = await import("crypto");
                        const hmac = crypto.createHmac("sha1", secret.value.get());
                        hmac.update(body);

                        const digest = `sha1=${hmac.digest("hex")}`;

                        if (!crypto.timingSafeEqual(Buffer.from(eventSig), Buffer.from(digest))) {
                            console.log(`[${eventId}] ignorning, bad signature ${digest} != ${eventSig}`);
                            return {
                                statusCode: 400,
                                body: "bad signature",
                            };
                        }

                        const event = JSON.parse(body.toString());

                        await args.handler({
                            request: req,
                            type: eventType,
                            id: eventId,
                            data: event,
                        });

                        return {
                            statusCode: 200,
                            body: "",
                        };
                    },
                },
            ],
        }, {
            parent: this,
        });

        if (args.repositories !== undefined) {
            for (const repo of args.repositories) {
                // tslint:disable-next-line no-unused-expression
                new GitHubWebhookResource(`${name}-registration-${repo.owner}-${repo.repo}`, {
                    owner: repo.owner,
                    repo: repo.repo,
                    secret: secret.value,
                    events: args.events,
                    url: api.url,
                }, {
                    parent: this,
                });
            }
        }

        if (args.organizations !== undefined) {
            for (const org of args.organizations) {
                // tslint:disable-next-line no-unused-expression
                new GitHubWebhookResource(`${name}-registration-${org}`, {
                    org: org,
                    secret: secret.value,
                    events: args.events,
                    url: api.url,
                }, {
                    parent: this,
                });
            }
        }

        this.url = api.url;
    }
}
