const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '../../tizen-app/css/style.css'), 'utf8');
test('player buttons keep the glass outline look (style D)', () => {
    assert.match(css, /glass outline look/);
    assert.match(css, /\.controls \.ctrl\s*\{[^}]*border:\s*2px solid rgba\(255,255,255,\.55\)/);
    assert.match(css, /\.controls \.ctrl:focus[^{]*\{[^}]*box-shadow:\s*0 0 24px var\(--accent\)/);
});

test('a focused tile keeps its padding so text does not run under the icon', () => {
    assert.match(css, /\.browse-list\.vm-tiles li\.focused\s*\{[^}]*padding-left:\s*134px/);
    assert.match(css, /\.browse-list\.vm-large li\.focused\s*\{[^}]*padding-left:\s*12px/);
});
