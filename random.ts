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

import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";

class RandomProvider implements dynamic.ResourceProvider {
    check = (olds: any, news: any) => {
        const failedChecks: dynamic.CheckFailure[] = [];

        if (news["byteCount"] === undefined) {
            failedChecks.push({property: "byteCount", reason: "required property 'byteCount' missing"});
        }

        if (!isNaN(news["byteCount"]) || news["byteCount"] <= 0) {
            failedChecks.push({property: "byteCount", reason: "'byteCount' should be a positive number"});
        }

        return Promise.resolve({ inputs: news, failedChecks: failedChecks });
    }

    diff = (id: pulumi.ID, olds: any, news: any) => {
        if (olds["byteCount"] !== news["byteCount"]) {
            return Promise.resolve({
                replaces: ["byteCount"],
            });
        }

        return Promise.resolve({});
    }

    create = async (inputs: any) => {
        const crypto = await import("crypto");
        const value = crypto.randomBytes(32).toString("base64");

        return {
            id: value,
            outs: {
                value: value,
            },
        };
    }

    update = (id: string, olds: any, news: any) => {
        return Promise.resolve({});
    }

    delete = async (id: pulumi.ID, props: any) => {
        return Promise.resolve();
    }
}

export class RandomResource extends dynamic.Resource {
    public readonly value: pulumi.Output<string>;

    constructor(name: string, byteCount: number, opts?: pulumi.ResourceOptions) {
        super(new RandomProvider(), name, {
            byteCount: byteCount,
            value: undefined,
        }, opts);
    }
}
