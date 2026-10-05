import { randomBytes, scryptSync } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal to enter a private password');
process.stdout.write('Owner password (minimum 12 characters; input hidden): ');
emitKeypressEvents(process.stdin); process.stdin.setRawMode(true);
let password = '';
process.stdin.on('keypress', (text, key) => {
  if (key.ctrl && key.name === 'c') process.exit(1);
  if (key.name === 'return') {
    process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
    if (password.length < 12 || password.length > 256) { console.error('Use between 12 and 256 characters'); process.exit(1); }
    const salt = randomBytes(16).toString('hex');
    console.log('OWNER_PASSWORD_HASH=' + salt + ':' + scryptSync(password, salt, 64).toString('hex'));
  } else if (key.name === 'backspace') password = password.slice(0, -1);
  else if (text && !key.ctrl && !key.meta) password += text;
});
