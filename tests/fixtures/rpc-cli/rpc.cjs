const { createInterface } = require('node:readline');
const mode = process.argv[2];
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (mode === 'exit') process.exit(1);
  if (mode === 'hang') return;
  if (mode === 'malformed') process.stdout.write('{bad}\n');
  else if (mode === 'malformed-last') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n{bad}\n');
  else if (mode === 'partial-last') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n{bad');
  else process.stdout.write(JSON.stringify({ id: request.id, result: { synthetic: true } }) + '\n');
});
