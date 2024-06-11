'use strict';
const YAML = require('yaml')
const fs = require('fs')

var appRoot = require('app-root-path');
const lambdaWrapper = require('lambda-wrapper');
const JSON5 = require('json5');
const moment = require('moment');
const excuted_timestamp = moment().valueOf();

function isPrimitive(test) {
    return test !== Object(test);
}
let saveValue = new Object();
function checkSaveValue(item, responseObject) {

    if (item.saveValue) {
        item.saveValue.forEach((keyObject, index) => {
            let ar = keyObject.path.split(".");
            let obj = responseObject
            for (let i = 0; i < ar.length; i++) {
                if (obj != undefined) {
                    obj = obj[ar[i]];
                }
            }

            saveValue[keyObject.saveas] = obj
        })
    }

}
function iterate(obj) {
    if (!(obj instanceof Object)) {
        return getValue(obj);
    }
    for (var property in obj) {

        if (obj.hasOwnProperty(property)) {
            if (typeof obj[property] == "object") {
                obj[property] = iterate(obj[property]);
            } else {
                let val = obj[property];
                obj[property] = getValue(val);
            }
        }
    }
    return obj;
}
function getValue(subject) {
    if (typeof subject != "string") {
        return subject;
    }
    let sign = subject.substring(0, 1);
    //커스텀 함수값
    if (subject == "$now") {
        return moment().valueOf();
    }
    else if (subject == "$excuted_timestamp") {
        return excuted_timestamp;
    }
    //이미 저장된 값
    else if (sign == "@") {
        let key = subject.substring(1);
        return saveValue[key];
    }
    else {
        return subject
    }
}
function _iterateExpect(response, value, path = "") {
    if (isPrimitive(value)) {
        if (response == value) {
            return {
                message: () =>
                    `expected ${value} =  ${value}`,
                pass: true,
            };
        } else {
            return {
                message: () =>
                    `expect ${path} to be ${value}, received: ${response}`,
                pass: false,
            };
        }
    }
    else {
        for (const property in value) {
            if (!response[property]) {
                return {
                    message: () =>
                        `expect ${path} to be ${value},not exist `,
                    pass: false,
                };

            }
            else {
                let tempResult = _iterateExpect(response[property], value[property], `${path}.${property}`)
                if (!tempResult.pass) {
                    return tempResult;
                }
            }
        }
        return {
            message: () =>
                `ok`,
            pass: true,
        };

    }
}

async function handleAuthorizer(authorizer, token) {
    const authorizerEvent = { headers: { authorization: `Bearer ${token}` } }
    const result = (await authorizer.handler(authorizerEvent)).context
    return result
}

expect.extend({
    myToBe(response, value) {
        const pass = response.statusCode == value;
        if (pass) {
            return {
                message: () =>
                    `expected ${response.statusCode} =  ${value}`,
                pass: true,
            };
        } else {
            return {
                message: () =>
                    `expected:${value},received: ${response.statusCode}, response:${(response.body)} `,
                pass: false,
            };
        }
    },
    iterateExpect(response, value) {
        return _iterateExpect(response, value, "response")
    }

});

function test(configFilePath = 'test_config.yml', lambdaPath = "/src/lambda/") {
    process.env.testing = true;
    var test_config = fs.readFileSync(configFilePath, 'utf8')
    const testDirection = YAML.parse(test_config);
    // authorizer 설정
    const authorizer = testDirection.authorizer ? require(appRoot + lambdaPath + testDirection.authorizer) : null
    beforeAll(async () => {
        //기본 설정

        try {
            jest.setTimeout(testDirection.timeout ? testDirection.timeout : 20000);

            if (!testDirection.useAWSSDKV3) {
                const AWS = require('aws-sdk');
                var credentials = new AWS.SharedIniFileCredentials({ profile: testDirection.aws_profile });
                AWS.config.credentials = credentials;



                if (testDirection.roleArn) {
                    const sts = new AWS.STS();
                    const timestamp = (new Date()).getTime();
                    const params = {
                        RoleArn: testDirection.roleArn, RoleSessionName: `rw-lambda-tester-${timestamp}`
                    };
                    const data = await sts.assumeRole(params).promise();
                    AWS.config.update({
                        accessKeyId: data.Credentials.AccessKeyId,
                        secretAccessKey: data.Credentials.SecretAccessKey,
                        sessionToken: data.Credentials.SessionToken,
                    });
                }
                AWS.config.update({ region: testDirection.region });
            }

            process.env.region = testDirection.region;

            //환경 변수 설정
            if (Array.isArray(testDirection.env)) {
                testDirection.env.forEach((item, index) => {
                    process.env[item.key] = item.value;
                });
            }
            else {
                for (var props in testDirection.env) {
                    process.env[props] = testDirection.env[props];
                }
            }
        } catch (e) {
            console.log(e);
            process.exit("could not assume the role:" + testDirection.roleArn)
        }
    });

    testDirection.test_targets.forEach((item, index) => {
        //method에 따른 input 설정
        //queryStringParameters,body에 둘다 넣는다. 
        let eventType = item.eventType ? item.eventType : "http";
        const mod = require(appRoot + lambdaPath + item.uri);

        const wrapped = lambdaWrapper.wrap(mod, { handler: 'handler' });

        const useAuthorizer = (mod.apiSpec && mod.apiSpec.event && mod.apiSpec.event[0] && mod.apiSpec.event[0].authorizer)

        it(item.uri + ((item.description) ? " " + item.description : ""), async () => {
            let authorizer_result = testDirection.claimsProfiles ? testDirection.claimsProfiles[item.claimsProfile] : undefined
            const authorizer_token = getValue(item.token)
            authorizer_result = authorizer && useAuthorizer ? await handleAuthorizer(authorizer, authorizer_token) : authorizer_result


            const givenParams = item.params ? item.params : item.parms

            let input = {
                queryStringParameters: givenParams, body: JSON.stringify(givenParams),
                requestContext:
                {
                    authorizer: {
                        jwt: {
                            claims: testDirection.claimsProfiles ? testDirection.claimsProfiles[item.claimsProfile] : undefined
                        },
                        // apiSpec에 authorizer설정되어있고 + authorizer 경로가 test에 넣어져 있으면 authorizer돌린 결과를 주기
                        // item.header에 jwt가 설정되어있어야함
                        lambda: authorizer_result
                    }
                },
                v3TestProfile: testDirection.useAWSSDKV3 ?

                    (testDirection.roleArn) ?
                        require("@aws-sdk/credential-providers").fromTemporaryCredentials({
                            masterCredentials: (testDirection.aws_profile) ? require("@aws-sdk/credential-provider-ini").fromIni({ profile: testDirection.aws_profile }) : undefined,
                            params: {
                                RoleArn: testDirection.roleArn,
                            }
                        }
                        ) : require("@aws-sdk/credential-provider-ini").fromIni({ profile: testDirection.aws_profile })

                    : undefined,

                ...item
            }

            if (givenParams) {
                if (typeof givenParams == 'string') {
                    input.queryStringParameters = givenParams

                } else {
                    for (var propert in givenParams) {
                        let customObject = givenParams[propert];
                        let val = "";
                        let key = "";


                        val = iterate(customObject)

                        if (input.body) {
                            let inputObject = JSON5.parse(input.body);

                            inputObject[propert] = val;

                            input.body = JSON.stringify(inputObject);
                        }
                        if (input.queryStringParameters) {
                            input.queryStringParameters[propert] = val;
                        }

                    }
                }
            }
            if (item.headers) {
                input.headers = {};
                for (var propert in item.headers) {
                    input.headers[propert] = item.headers[propert];
                }
            }


            return wrapped.run(input).then(async (response) => {
                console.log("\u001b[1;35m " + item.uri + ": result:" + JSON.stringify(response) + "\u001b[1;0m")
                try {
                    if (item.expect != undefined) {
                        if (eventType == "http") {

                            if (item.expect.checkType == "check_200") {
                                if (item.expect.not) {
                                    await expect(response).not.myToBe(200);
                                }
                                else {
                                    await expect(response).myToBe(200);
                                }
                            }
                            else if (item.expect.checkType == "check_value") {
                                let responseObject = JSON5.parse(response.body)
                                if (item.expect.not) {
                                    await expect(responseObject).not.iterateExpect(getValue(item.expect.target));
                                }
                                else {
                                    await expect(responseObject).iterateExpect(getValue(item.expect.target));
                                }
                            }
                        }

                    }

                    let responseObject = JSON5.parse(response.body)
                    checkSaveValue(item, responseObject)
                }
                catch (e) {
                    throw e;  // <= set your breakpoint here
                }
            })
        });
    });
}
module.exports.test = test;
