const { MarkItDown } = require('markitdown-js');
const converter = new MarkItDown();
// Join all args so callers can pass paths with spaces without quoting
const file = process.argv.slice(2).join(' ');
if (!file) { console.error('Usage: node convert.js <file>'); process.exit(1); }
converter.convert(file).then(result => {
  if (result && result.textContent) {
    process.stdout.write(result.textContent);
  } else {
    console.error('Failed or no content:', JSON.stringify(result));
    process.exit(1);
  }
});
