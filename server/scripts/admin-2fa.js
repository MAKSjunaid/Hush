// Creates a secret for 2-step admin login. Add it to ADMIN_TOTP_SECRET, then scan the link/QR in Google Authenticator.
import { generateSecret, generateURI } from 'otplib';
const secret = generateSecret();
console.log('\nADMIN_TOTP_SECRET=' + secret);
console.log('\nAdd this to your authenticator app (or paste the link into a QR generator):');
console.log(generateURI({ secret, label: 'admin', issuer: 'Hush' }) + '\n');
