// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Thingpedia
//
// Copyright 2016-2019 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>

import assert from 'assert';
import * as crypto from 'crypto';
import * as oauth from 'oauth';

import { OAuthError } from '../errors';
import type BaseEngine from '../base_engine';
import type BaseDevice from '../base_device';

/* eslint-disable no-invalid-this */

// encryption ;)
function rot13(x : string) : string {
    return Array.prototype.map.call(x, (ch) => {
        let code = ch.charCodeAt(0);
        if (code >= 0x41 && code <= 0x5a)
            code = (((code - 0x41) + 13) % 26) + 0x41;
        else if (code >= 0x61 && code <= 0x7a)
            code = (((code - 0x61) + 13) % 26) + 0x61;

        return String.fromCharCode(code);
    }).join('');
}

type OAuthCodeQuery = {
    response_type : 'code';
    redirect_uri : string;
    access_type ?: string;
    state ?: string;
    scope ?: string;
};

namespace OAuth2Helper {
export interface OAuthHelperParams<T extends BaseDevice> {
    client_id ?: string;
    client_secret ?: string;
    use_basic_client_auth ?: boolean;
    custom_headers ?: Record<string, string>;
    authorize ?: string;
    get_access_token ?: string;
    redirect_uri ?: string;
    set_access_type ?: boolean;
    set_state ?: boolean;
    scope ?: string[];
    callback ?: (engine : BaseEngine, accessToken : string, refreshToken : string, extraData : Record<string, unknown>) => Promise<T>;
}

export type DeviceClass<T extends BaseDevice> = BaseDevice.DeviceClass<T> & {
    loadFromOAuth2(engine : BaseEngine, accessToken : string, refreshToken : string, extraData : Record<string, unknown>) : Promise<T>;
};

export interface HTTPRequest {
    query : Record<string, string|string[]|undefined>;
    session : Record<string, string>;
}

export interface OAuthRunner<T extends BaseDevice> {
    (this : DeviceClass<T>, engine : BaseEngine, req : null) : [string, Record<string, string>];
    (this : DeviceClass<T>, engine : BaseEngine, req : HTTPRequest) : Promise<T|null>;
    install(classdef : T) : void;
}
}

function makeOAuthClient<T extends BaseDevice>(params : OAuth2Helper.OAuthHelperParams<T>,
                                               factory : OAuth2Helper.DeviceClass<T>,
                                               engine : BaseEngine) : [oauth.OAuth2, string] {
    if (!factory.metadata.auth.client_id && !params.client_id)
        throw new OAuthError('Missing OAuth Client ID in Authentication part of the manifest');
    const client_id = (factory.metadata.auth.client_id || params.client_id) as string;
    if (!factory.metadata.auth.client_secret && !params.client_secret)
        throw new OAuthError('Missing OAuth Client Secret in Authentication part of the manifest');
    const client_secret = factory.metadata.auth.client_secret || rot13(params.client_secret!);

    const customHeaders = params.custom_headers || {};
    if (params.use_basic_client_auth) {
        console.log('Setting basic auth header');
        customHeaders['Authorization'] = 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'));
    }
    const auth = new oauth.OAuth2(client_id,
                                  client_secret,
                                  '',
                                  params.authorize,
                                  params.get_access_token,
                                  customHeaders);
    auth.useAuthorizationHeaderforGET(true);
    const origin = engine.platform.getOAuthRedirect();
    let redirect_uri;
    if (params.redirect_uri)
        redirect_uri = params.redirect_uri;
    else
        redirect_uri = origin + '/devices/oauth2/callback/' + factory.metadata.kind;

    return [auth, redirect_uri];
}

function oauthPart1<T extends BaseDevice>(params : OAuth2Helper.OAuthHelperParams<T>,
                                          factory : OAuth2Helper.DeviceClass<T>,
                                          engine : BaseEngine) : [string, Record<string, string>] {
    const [client, redirect_uri] = makeOAuthClient(params, factory, engine);

    const session : Record<string, string> = {};
    const query : OAuthCodeQuery = {
        response_type: 'code',
        redirect_uri: redirect_uri,
    };
    if (params.set_access_type)
        query.access_type = 'offline';
    if (params.set_state) {
        const state = crypto.randomBytes(16).toString('hex');
        query.state = state;
        session['oauth2-state-' + factory.metadata.kind] = state;
    }
    if (params.scope)
        query.scope = params.scope.join(' ');

    return [client.getAuthorizeUrl(query), session];
}

function oauthPart2<T extends BaseDevice>(params : OAuth2Helper.OAuthHelperParams<T>,
                                          factory : OAuth2Helper.DeviceClass<T>,
                                          engine : BaseEngine,
                                          req : OAuth2Helper.HTTPRequest) : Promise<T|null> {
    const [client, redirect_uri] = makeOAuthClient(params, factory, engine);

    const expectedState = req.session['oauth2-state-' + factory.metadata.kind];
    delete req.session['oauth2-state-' + factory.metadata.kind];

    // according to RFC 6749, if the user cancels, or some error
    // occurs, the browser is redirected to the configured redirect URL,
    // but with the `error` query parameter set to an error code
    // (https://tools.ietf.org/html/rfc6749#section-4.1.2.1)
    //
    // Of the error codes defined, `access_denied` can be triggered
    // legitimately if the user cancels / changes their mind, while
    // the others are all programming or configuration errors
    if (req.query.error) {
        if (req.query.error === 'access_denied') {
            // if the user cancels, do nothing, successfully
            return Promise.resolve(null);
        } else {
            // fail with an error - the error is in Thingpedia, not
            // in the client

            let msg;
            if (req.query.error_description)
                msg = String(req.query.error_description);
            else
                msg = String(req.query.error);

            return Promise.reject(new OAuthError(msg));
        }
    }

    const code = req.query.code;
    assert(typeof code === 'string');

    // NOTE: according to RFC 6749, `state` should be set on errors too
    // we are more lenient, and allow state to be unset on errors
    const state = req.query.state;
    if (params.set_state && state !== expectedState)
        return Promise.reject(new OAuthError("Invalid CSRF token"));

    const options = {
        grant_type: 'authorization_code',
        redirect_uri: redirect_uri
    };
    return (new Promise<[string, string, Record<string, unknown>]>((resolve, reject) => {
        client.getOAuthAccessToken(code, options, (err : any, accessToken : string, refreshToken : string, extraData : Record<string, unknown>) => {
            if (err)
                reject(err);
            else
                resolve([accessToken, refreshToken, extraData]);
        });
    })).then(([accessToken, refreshToken, extraData]) => {
        if (params.callback)
            return params.callback(engine, accessToken, refreshToken, extraData) as Promise<T>;
        else
            return factory.loadFromOAuth2(engine, accessToken, refreshToken, extraData) as Promise<T>;
    }).catch((e) : never => {
        console.error('Error obtaining access token', e);
        if (!e.message)
            throw new OAuthError('Error obtaining access token');
        else
            throw new OAuthError(e.message);
    });
}

function oauthRefresh<T extends BaseDevice>(self : T,
                                            params : OAuth2Helper.OAuthHelperParams<T>) {
    const factory = self.constructor as OAuth2Helper.DeviceClass<T>;
    const [client, redirect_uri] = makeOAuthClient(params, factory, self.engine);

    const options = {
        grant_type: 'refresh_token',
        redirect_uri: redirect_uri
    };
    return (new Promise<[string, string, Record<string, unknown>]>((resolve, reject) => {
        client.getOAuthAccessToken(self.state.refreshToken!, options, (err : any, accessToken : string, refreshToken : string, extraData : Record<string, unknown>) => {
            if (err)
                reject(err);
            else
                resolve([accessToken, refreshToken, extraData]);
        });
    })).then(([accessToken, refreshToken, extraData] : [string, string, Record<string, unknown>]) => {
        return self.updateOAuth2Token(accessToken, refreshToken, extraData);
    }).catch((e) => {
        console.error('Error obtaining access token', e);
        if (!e.message)
            throw new OAuthError('Error obtaining access token');
        else
            throw new OAuthError(e.message);
    });
}

function OAuth2Helper<T extends BaseDevice>(params : OAuth2Helper.OAuthHelperParams<T>) : OAuth2Helper.OAuthRunner<T> {
    function runOAuth2(this : OAuth2Helper.DeviceClass<T>, engine : BaseEngine, req : null) : [string, Record<string, string>];
    function runOAuth2(this : OAuth2Helper.DeviceClass<T>, engine : BaseEngine, req : OAuth2Helper.HTTPRequest) : Promise<T|null>;
    function runOAuth2(this : OAuth2Helper.DeviceClass<T>, engine : BaseEngine, req : OAuth2Helper.HTTPRequest|null) {
        if (req === null) {
            // step 1
            return oauthPart1(params, this, engine);
        } else {
            // step 2
            return oauthPart2(params, this, engine, req);
        }
    }

    runOAuth2.install = function install(classdef : T) {
        Object.defineProperty(classdef, 'refreshCredentials', {
            value: function refreshCredentials(this : T) : Promise<void> {
                return oauthRefresh(this, params);
            },
            configurable: true,
            enumerable: false,
            writable: true
        });

        // ignore errors definining the properties, in case
        // a class already has its own definitions
        try {
            Object.defineProperty(classdef, 'accessToken', {
                configurable: false,
                enumerable: true,
                get: function() {
                    return this.state.accessToken;
                }
            });
        } catch(e) {
            // ignore
        }
        try {
            Object.defineProperty(classdef, 'refreshToken', {
                configurable: false,
                enumerable: true,
                get: function() {
                    return this.state.refreshToken;
                }
            });
        } catch(e) {
            // ignore
        }

        const oldqueryInterface = classdef.queryInterface;
        Object.defineProperty(classdef, 'queryInterface', {
            value: function queryInterface(iface : string) {
                if (iface === 'oauth2')
                    return this;
                else
                    return oldqueryInterface ? oldqueryInterface.call(this, iface) : null;
            },
            configurable: true,
            enumerable: false,
            writable: true
        });
    };

    return runOAuth2;
}
export default OAuth2Helper;
