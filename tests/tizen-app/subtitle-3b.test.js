'use strict';

var assert = require('assert');
var test = require('node:test');
var S = require('../../tizen-app/js/settings.js');
var TextDecode = require('../../tizen-app/js/text-decode.js');
var LanguageList = S.LanguageList;

test('Arabic file names are matched to the language', function () {
    assert.ok(LanguageList.subScore('ar', 'ar', 'movie.ar.srt', 'srt', true) > 0);
    assert.ok(LanguageList.subScore('ar', 'ara', 'movie.ara.srt', 'srt', true) > 0);
    assert.ok(LanguageList.subScore('ar', '', 'Arabic.srt', 'srt', true) > 0);
    assert.strictEqual(LanguageList.subScore('ar', 'en', 'movie.en.srt', 'srt', true), 0);
});

test('.srt beats .ass for the same language', function () {
    var srt = LanguageList.subScore('en', 'en', 'movie.en.srt', 'srt', true);
    var ass = LanguageList.subScore('en', 'en', 'movie.en.ass', 'ass', true);
    assert.ok(srt > ass);
});

test('forced and SDH files lose to a normal one but still match when alone', function () {
    var normal = LanguageList.subScore('en', 'en', 'movie.en.srt', 'srt', true);
    var forced = LanguageList.subScore('en', 'en', 'movie.en.forced.srt', 'srt', true);
    var sdh    = LanguageList.subScore('en', 'en', 'movie.en.sdh.srt', 'srt', true);
    assert.ok(normal > forced);
    assert.ok(normal > sdh);
    assert.ok(forced > 0 && sdh > 0);
});

test('the second-language list starts with None and has no Auto row', function () {
    var l = LanguageList.forSubtitle2();
    assert.strictEqual(l[0].code, '');
    assert.strictEqual(l[0].name, 'None');
    assert.ok(l.every(function (x, i) { return i === 0 || x.code !== ''; }));
});

test('a forced text encoding is used instead of the guess', function () {
    // "Привет" in windows-1251, which is not valid UTF-8
    var bytes = new Uint8Array([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2]);
    assert.strictEqual(TextDecode.decode(bytes, 'windows-1251').text, 'Привет');
    assert.strictEqual(TextDecode.decode(bytes, 'windows-1256').encoding, 'WINDOWS-1256');
});
