/** A software passkey authenticator for tests (attestation "none", user verification), like a platform authenticator. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

// Minimal CBOR: unsigned / negative integers, byte and text strings, maps.
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor');
}

export class Authenticator {
  readonly credentialId = randomBytes(16);
  private key: KeyObject;
  readonly publicJwk: { x: string; y: string };
  private count = 0;
  handle = Buffer.alloc(0);
  skipUV = false;

  constructor(
    public origin: string,
    public rpId: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
  }

  /** The COSE public key, as stored by relying parties. */
  cose(): Buffer {
    return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.publicJwk.x, 'base64url')], [-3, Buffer.from(this.publicJwk.y, 'base64url')]]));
  }

  private authData(attested: boolean): Buffer {
    const flags = 0x01 | (this.skipUV ? 0 : 0x04) | (attested ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.count);
    const parts: Buffer[] = [createHash('sha256').update(this.rpId).digest(), Buffer.from([flags]), counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.cose());
    }
    return Buffer.concat(parts);
  }

  private client(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  create(options: { publicKey: { challenge: string; user: { id: string } } }) {
    this.handle = Buffer.from(options.publicKey.user.id, 'base64url');
    const att = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(true)]]));
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64(this.client('webauthn.create', options.publicKey.challenge)), attestationObject: b64(att), transports: ['internal'] },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }

  get(options: { publicKey: { challenge: string } }) {
    const cd = this.client('webauthn.get', options.publicKey.challenge);
    const ad = this.authData(false);
    const sig = sign('sha256', Buffer.concat([ad, createHash('sha256').update(cd).digest()]), this.key);
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(sig), userHandle: b64(this.handle) },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }
}
