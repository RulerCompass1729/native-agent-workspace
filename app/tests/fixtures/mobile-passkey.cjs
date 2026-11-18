// Synthetic ES256 authenticator. Proves verifier behavior, not real hardware/Face ID.
const crypto = require('node:crypto');
const b64 = b => Buffer.from(b).toString('base64url');
function cbor(v) {
  const head = (m,n) => n < 24 ? Buffer.from([m*32+n]) : n < 256 ? Buffer.from([m*32+24,n]) : Buffer.from([m*32+25,n>>8,n&255]);
  if (typeof v === 'number') return v < 0 ? head(1,-1-v) : head(0,v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2,v.length),v]);
  if (typeof v === 'string') return Buffer.concat([head(3,Buffer.byteLength(v)),Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5,v.size),...[...v].flatMap(([k,x])=>[cbor(k),cbor(x)])]);
  throw Error('Unsupported synthetic CBOR');
}
function signer(origin = 'https://phone.example.test') {
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk=publicKey.export({format:'jwk'}),id=crypto.randomBytes(32);
  const client=(challenge,type,changes)=>Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false,...changes}));
  const rp=changes=>crypto.createHash('sha256').update(changes?.rpId || new URL(origin).hostname).digest();
  return {
    credential(options,changes={}) {
      const key=cbor(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]])),size=Buffer.alloc(2);size.writeUInt16BE(id.length);
      const auth=Buffer.concat([rp(changes),Buffer.from([changes.flags??0x45]),Buffer.alloc(4),Buffer.alloc(16),size,id,key]);
      return {id:b64(id),rawId:b64(id),type:'public-key',response:{clientDataJSON:b64(client(options.challenge,'webauthn.create',changes.client)),attestationObject:b64(cbor(new Map([['fmt','none'],['authData',auth],['attStmt',new Map()]])))},clientExtensionResults:{}};
    },
    assertion(options,changes={}) {
      const data=client(options.challenge,'webauthn.get',changes.client),auth=Buffer.concat([rp(changes),Buffer.from([changes.flags??5]),Buffer.alloc(4)]);
      return {id:b64(id),rawId:b64(id),type:'public-key',response:{clientDataJSON:b64(data),authenticatorData:b64(auth),signature:b64(crypto.sign('sha256',Buffer.concat([auth,crypto.createHash('sha256').update(data).digest()]),privateKey)),userHandle:null},clientExtensionResults:{}};
    }
  };
}
module.exports={signer};
