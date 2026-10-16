/**
 * Where a request comes from, for the free talk allowance only: whether it arrives through an anonymising network
 * (Tor, a VPN service, a hosting or cloud provider), and a per-network key for the daily cap on free conversations
 * from one address. The address itself is never stored: the key is an HMAC of it under the visitor secret, so the
 * counters table holds no IP and the key changes if the secret is rotated.
 *
 * Neither is a wall: a determined person can find a residential proxy. They make the free tier not worth farming.
 * Akamai, Cloudflare and Fastly are left out on purpose: Apple's iCloud Private Relay leaves through them, and a
 * Safari user with it switched on is a visitor, not an abuser.
 */

/** Organisations whose networks are VPN services, hosting or cloud providers, not homes, offices or phones. */
const ANONYMOUS_ORG =
  /\b(vpn|proxy|hosting|datacent(?:er|re)|data cent(?:er|re)|vps|colocation|amazon|aws|google cloud|digitalocean|linode|ovh|hetzner|scaleway|contabo|vultr|choopa|constant company|leaseweb|m247|datacamp|cdn77|psychz|quadranet|tzulo|g-core|gcore|packethub|mullvad|nordvpn|tefincom|proton ag|expressvpn|surfshark|private internet access|ipvanish|cyberghost|windscribe|hide\.me|zenlayer|frantech|buyvm|servers\.com|oracle|alibaba|tencent|hostinger|ionos|online s\.a\.s|clouvider|terrahost|hostroyale|tor exit)\b/i;

/** The parts of request.cf this module reads. */
export interface RequestOrigin {
  country?: string;
  asOrganization?: string;
}

/** Tor (Cloudflare marks it with the pseudo-country T1) or an organisation that runs VPNs, hosting or clouds. */
export const anonymousNetwork = (cf: RequestOrigin | undefined): boolean =>
  cf?.country === 'T1' || ANONYMOUS_ORG.test(cf?.asOrganization ?? '');

const encoder = new TextEncoder();

/** A short, stable key for the connecting address: HMAC-SHA-256 under the secret, first 16 bytes as hex. */
export async function networkKey(secret: string, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`net:${ip}`)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
