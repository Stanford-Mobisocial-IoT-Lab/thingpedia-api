// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See LICENSE for details
"use strict";

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ModuleDownloader = require('../lib/downloader');
const BaseDevice = require('../lib/base_device');

const { MockPlatform, MockEngine } = require('./mock');

const Builtins = {
    'org.thingpedia.builtin.translatable': {
        class: fs.readFileSync(path.resolve(path.dirname(module.filename), './device-classes/org.thingpedia.builtin.translatable.tt'), { encoding: 'utf8' }),
        module: class TranslatableBuiltin extends BaseDevice {
            get_elements() {
                return [];
            }
        }
    }
};

async function testBasic() {
    const platform = new MockPlatform('it-IT');
    const engine = new MockEngine(platform);
    const tpClient = platform.getCapability('thingpedia-client');

    const downloader = new ModuleDownloader(platform, tpClient, engine.schemas, Builtins, {
        builtinGettextDomain: 'thingengine-core'
    });
    const module = await downloader.getModule('org.thingpedia.builtin.translatable');

    assert.strictEqual(module.manifest.prettyprint(), `class @org.thingpedia.builtin.test.invalid
#_[name="Predefinito Traducibile"]
#_[description="Descrizione del Predefinito Traducibile"]
#[version=0] {
  import loader from @org.thingpedia.builtin();
  import config from @org.thingpedia.config.builtin();

  monitorable query elements(out something: String #_[canonical="qualcosa"],
                             out author: Entity(tt:username) #_[canonical={npp=["autore"],pvp=["scritto da"],default="npp"}])
  #_[confirmation="elementi predefiniti dentro la roba"]
  #_[canonical="elementi"]
  #[poll_interval=1ms];
}
`);

    const _class = await module.getDeviceClass();
    const dev = new _class(engine, { kind: 'org.thingpedia.builtin.translatable' });

    assert.strictEqual(dev.name, 'Predefinito Traducibile');
    assert.strictEqual(dev.description, 'Descrizione del Predefinito Traducibile');
}

async function main() {
    await testBasic();
}
module.exports = main;
if (!module.parent)
    main();
