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
	async load() {
		const ifname = 'tailscale0';
		const parsedInfo = { name: ifname };

		// Read statistics from sysfs and IP info in parallel
		const [rxRes, txRes, mtuRes, ipRes] = await Promise.all([
			fs.read('/sys/class/net/' + ifname + '/statistics/rx_bytes'),
			fs.read('/sys/class/net/' + ifname + '/statistics/tx_bytes'),
			fs.read('/sys/class/net/' + ifname + '/mtu'),
			fs.exec('/sbin/ip', ['addr', 'show', ifname])
		]);

		// If interface doesn't exist, return empty
		if (!rxRes && !mtuRes && (!ipRes || ipRes.code !== 0)) {
			return [];
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

		return [parsedInfo];
	},

	pollData(container) {
		poll.add(async () => {
			const data = await this.load();
			dom.content(container, this.renderContent(data));
		});
	},

	renderContent(data) {
		if (!Array.isArray(data) || data.length === 0) {
			return E('div', {}, _('No interface online.'));
		}
		const rows = [
			E('th', { class: 'th', colspan: '2' }, _('Network Interface Information'))
		];
		data.forEach(interfaceData => {
			rows.push(
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', width: '25%' }, _('Interface Name')),
					E('td', { class: 'td left', width: '25%' }, interfaceData.name)
				]),
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', width: '25%' }, _('IPv4 Address')),
					E('td', { class: 'td left', width: '25%' }, interfaceData.ipv4)
				]),
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', width: '25%' }, _('IPv6 Address')),
					E('td', { class: 'td left', width: '25%' }, interfaceData.ipv6)
				]),
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', width: '25%' }, _('MTU')),
					E('td', { class: 'td left', width: '25%' }, interfaceData.mtu)
				]),
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', width: '25%' }, _('Total Download')),
					E('td', { class: 'td left', width: '25%' }, interfaceData.rxBytes)
				]),
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', width: '25%' }, _('Total Upload')),
					E('td', { class: 'td left', width: '25%' }, interfaceData.txBytes)
				])
			);
		});

		return E('table', { 'class': 'table' }, rows);
	},

	render(data) {
		const content = E([], [
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
