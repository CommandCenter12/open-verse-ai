// Software WebAuthn authenticator for tests: a real P-256 key, real signatures,
// with switches to simulate attacks (no user verification, replayed counter, wrong origin...).
import { isoCBOR, isoBase64URL } from '@simplewebauthn/server/helpers';

const b64 = (u8) => isoBase64URL.fromBuffer(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const enc = new TextEncoder();
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// WebCrypto ECDSA signatures are raw r||s; WebAuthn uses ASN.1 DER.
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class SoftAuthenticator {
  constructor() { this.counter = 0; }

  async create(options, origin, { uv = true, rpId = options.rp.id } = {}) {
    this.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    this.credId = crypto.getRandomValues(new Uint8Array(16));
    this.rpId = rpId;
    this.userHandle = options.user.id;
    const cose = isoCBOR.encode(new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)],
    ]));
    const flags = 0x01 | (uv ? 0x04 : 0) | 0x40; // UP | UV | AT
    const authData = concat(await sha256(enc.encode(rpId)), new Uint8Array([flags]), u32(this.counter),
      new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId, cose);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64(this.credId), rawId: b64(this.credId), type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }

  async get(options, origin, { uv = true, counter, tamper = false, rpId = this.rpId } = {}) {
    this.counter = counter ?? this.counter + 1;
    const flags = 0x01 | (uv ? 0x04 : 0);
    const authData = concat(await sha256(enc.encode(rpId)), new Uint8Array([flags]), u32(this.counter));
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
    if (tamper) raw[10] ^= 0xff;
    return {
      id: b64(this.credId), rawId: b64(this.credId), type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(rawToDer(raw)), userHandle: this.userHandle },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }
}
