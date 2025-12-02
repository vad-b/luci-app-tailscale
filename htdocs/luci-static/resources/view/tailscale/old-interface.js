/* SPDX-License-Identifier: GPL-3.0-only
 *
 * Copyright (C) 2022 ImmortalWrt.org
 * Copyright (C) 2024 asvow
 */

'use strict';
'require dom';
'require fs';
'require poll';
'require ui';
'require view';

return view.extend({
	async loadInterfaceInfo() {
		const ifname = 'tailscale0';
		const parsedInfo = { name: ifname };

		// Read statistics from sysfs and IP info in parallel
		const [rxRes, txRes, mtuRes, ipRes] = await Promise.all([
			fs.read('/sys/class/net/' + ifname + '/statistics/rx_bytes'),
			fs.read('/sys/class/net/' + ifname + '/statistics/tx_bytes'),
			fs.read('/sys/class/net/' + ifname + '/mtu'),
			fs.exec('/sbin/ip', ['addr', 'show', ifname])
		]);

		// If interface doesn't exist, return null
		if (!rxRes && !mtuRes && (!ipRes || ipRes.code !== 0)) {
			return null;
		}

		// Parse rx/tx bytes
		parsedInfo.rxBytes = rxRes ? '%1024mB'.format(parseInt(rxRes.trim(), 10) || 0) : '-';
		parsedInfo.txBytes = txRes ? '%1024mB'.format(parseInt(txRes.trim(), 10) || 0) : '-';
		parsedInfo.mtu = mtuRes ? mtuRes.trim() : '-';

		// Parse IP addresses from `ip addr show` output
		if (ipRes && ipRes.code === 0 && ipRes.stdout) {
			const lines = ipRes.stdout.split('\n');
			for (const line of lines) {
				// Match IPv4: "inet 100.80.52.1/32 scope global tailscale0"
				const ipv4Match = line.match(/^\s*inet\s+([0-9.]+)/);
				if (ipv4Match && !parsedInfo.ipv4) {
					parsedInfo.ipv4 = ipv4Match[1];
				}
				// Match IPv6 (skip link-local fe80::): "inet6 fd7a:115c:a1e0::9f01:1560/128 scope global"
				const ipv6Match = line.match(/^\s*inet6\s+([0-9a-fA-F:]+)/);
				if (ipv6Match && !parsedInfo.ipv6 && !ipv6Match[1].startsWith('fe80')) {
					parsedInfo.ipv6 = ipv6Match[1];
				}
			}
		}

		parsedInfo.ipv4 = parsedInfo.ipv4 || '-';
		parsedInfo.ipv6 = parsedInfo.ipv6 || '-';

		return parsedInfo;
	},

	async loadPeerStatus() {
		const statusRes = await fs.exec('tailscale', ['status', '--json']).catch(err => ({
			code: 1,
			message: err.message || 'Failed to execute tailscale command'
		}));

		if (statusRes.code !== 0) {
			const message = typeof statusRes.message === 'string' ? statusRes.message : 'Command failed';
			if (message.includes('Permission')) {
				return { error: _('Permission denied: Ensure LuCI has access to run "tailscale status".') };
			} else if (message.includes('not running') || message.includes('stopped')) {
				return { error: _('Tailscale service is not running.') };
			}
			return { error: _('Unable to get Tailscale status: %s').format(message) };
		}

		if (!statusRes.stdout || statusRes.stdout.trim() === '') {
			return { error: _('Tailscale status returned empty output.') };
		}

		try {
			const statusJson = JSON.parse(statusRes.stdout);
			const peers = statusJson.Peer || {};
			const peerList = [];

			for (const peer of Object.values(peers)) {
				// Use DNSName (e.g., "device-name.tailnet.ts.net.") and extract the first part
				const hostname = peer.DNSName ? peer.DNSName.split('.')[0] : (peer.HostName || '-');

				peerList.push({
					ip: peer.TailscaleIPs?.[0] || '-',
					hostname: hostname,
					online: peer.Online,
					relay: peer.Relay || '-',
					direct: !!peer.CurAddr,
					rxBytes: peer.RxBytes ? '%1024mB'.format(peer.RxBytes) : '-',
					txBytes: peer.TxBytes ? '%1024mB'.format(peer.TxBytes) : '-'
				});
			}

			return { peers: peerList };
		} catch (e) {
			return { error: _('Error parsing Tailscale status: %s').format(e.message) };
		}
	},

	async load() {
		const [interfaceInfo, peerStatus] = await Promise.all([
			this.loadInterfaceInfo(),
			this.loadPeerStatus()
		]);

		return { interfaceInfo, peerStatus };
	},

	pollData(container) {
		poll.add(async () => {
			const data = await this.load();
			dom.content(container, this.renderContent(data));
		});
	},

	renderInterfaceTable(interfaceInfo) {
		if (!interfaceInfo) {
			return E('div', { class: 'cbi-value' }, _('No interface online.'));
		}

		return E('table', { class: 'table' }, [
			E('tr', { class: 'tr' }, [
				E('th', { class: 'th left', colspan: '2' }, _('Network Interface Information'))
			]),
			E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', width: '25%' }, _('Interface Name')),
				E('td', { class: 'td left' }, interfaceInfo.name)
			]),
			E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', width: '25%' }, _('IPv4 Address')),
				E('td', { class: 'td left' }, interfaceInfo.ipv4)
			]),
			E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', width: '25%' }, _('IPv6 Address')),
				E('td', { class: 'td left' }, interfaceInfo.ipv6)
			]),
			E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', width: '25%' }, _('MTU')),
				E('td', { class: 'td left' }, interfaceInfo.mtu)
			]),
			E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', width: '25%' }, _('Total Download')),
				E('td', { class: 'td left' }, interfaceInfo.rxBytes)
			]),
			E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', width: '25%' }, _('Total Upload')),
				E('td', { class: 'td left' }, interfaceInfo.txBytes)
			])
		]);
	},

	renderPeerTable(peerStatus) {
		const rows = [
			E('tr', { class: 'tr' }, [
				E('th', { class: 'th left', colspan: '7' }, _('Peer Status'))
			]),
			E('tr', { class: 'tr cbi-section-table-titles' }, [
				E('th', { class: 'th left' }, _('IP')),
				E('th', { class: 'th left' }, _('Hostname')),
				E('th', { class: 'th left' }, _('Status')),
				E('th', { class: 'th left' }, _('Connection')),
				E('th', { class: 'th left' }, _('Relay')),
				E('th', { class: 'th left' }, _('Download')),
				E('th', { class: 'th left' }, _('Upload'))
			])
		];

		if (peerStatus.error) {
			rows.push(E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', colspan: '7' }, peerStatus.error)
			]));
		} else if (!peerStatus.peers || peerStatus.peers.length === 0) {
			rows.push(E('tr', { class: 'tr' }, [
				E('td', { class: 'td left', colspan: '7' }, _('No peers found.'))
			]));
		} else {
			peerStatus.peers.forEach(peer => {
				rows.push(E('tr', { class: 'tr' }, [
					E('td', { class: 'td left' }, peer.ip),
					E('td', { class: 'td left' }, peer.hostname),
					E('td', { class: 'td left' }, peer.online ? _('Online') : _('Offline')),
					E('td', { class: 'td left' }, peer.direct ? _('Direct') : _('Relayed')),
					E('td', { class: 'td left' }, peer.relay),
					E('td', { class: 'td left' }, peer.rxBytes),
					E('td', { class: 'td left' }, peer.txBytes)
				]));
			});
		}

		return E('table', { class: 'table', style: 'margin-top: 1em;' }, rows);
	},

	renderContent(data) {
		return E('div', {}, [
			this.renderInterfaceTable(data.interfaceInfo),
			this.renderPeerTable(data.peerStatus)
		]);
	},

	render(data) {
		const content = E('div', {}, [
			E('h2', { class: 'content' }, _('Tailscale')),
			E('div', { class: 'cbi-map-descr' }, _('Tailscale is a cross-platform and easy to use virtual LAN.')),
			E('div')
		]);
		const container = content.lastElementChild;

		dom.content(container, this.renderContent(data));
		this.pollData(container);

		return content;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
