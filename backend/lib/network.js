const os = require('os');

function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // IPv4 and non-internal only
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({
          interface: name,
          ip: net.address,
          isWifi: /wi-?fi|wlan|wireless/i.test(name)
        });
      }
    }
  }

  // Sort Wi-Fi first, then other adapters
  addresses.sort((a, b) => (b.isWifi ? 1 : 0) - (a.isWifi ? 1 : 0));

  return addresses;
}

function getPrimaryIp() {
  const addresses = getNetworkAddresses();
  if (addresses.length > 0) {
    return addresses[0].ip;
  }
  return '127.0.0.1';
}

module.exports = {
  getNetworkAddresses,
  getPrimaryIp
};
