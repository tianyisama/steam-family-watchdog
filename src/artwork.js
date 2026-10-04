// Paths come from Steam's family library; URLs are restricted to Steam CDNs.
export function artwork(appid, capsuleFilename, iconHash) {
  const capsule = typeof capsuleFilename === 'string' && capsuleFilename.length <= 512
    && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(capsuleFilename)
    && !capsuleFilename.split('/').some(part => part === '.' || part === '..')
    ? capsuleFilename : null;
  const icon = typeof iconHash === 'string' && /^[a-f0-9]{40}$/i.test(iconHash)
    ? iconHash.toLowerCase() : null;
  const capsuleUrl = capsule
    ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${capsule.split('/').map(encodeURIComponent).join('/')}` : null;
  const iconUrl = icon
    ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${icon}.jpg` : null;
  return {
    capsule_filename: capsule,
    img_icon_hash: icon,
    capsule_image_url: capsuleUrl,
    icon_image_url: iconUrl,
    image_url: capsuleUrl || iconUrl,
  };
}
