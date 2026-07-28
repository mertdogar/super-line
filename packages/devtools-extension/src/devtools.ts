// The devtools page exists only to create the panel. It runs whenever DevTools is open on a tab,
// and is destroyed when DevTools closes.
//
// The panel path is resolved from the EXTENSION ROOT, not from this file — the single most common
// way a DevTools extension ends up with a blank panel. Both HTML entries build to the root of dist/,
// so 'panel.html' is correct here and would NOT be if this file moved into a subdirectory.
chrome.devtools.panels.create('super-line', '', 'panel.html')
