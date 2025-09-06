
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// === Konfigurasi dari .env atau hardcode sementara ===
const TOKEN = process.env.TELEGRAM_TOKEN || '8462418931:AAH1VhFEfrsHUIn3HA7LSeiam0SCW7bplK8';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '688909275';
const SHEET_ID = process.env.SHEET_ID || '1MEGEiAN6pyMLRKXsdqymxasOGLdLTMv7ts3LSb3C27Y';
const SHEET_STOCK = 'STOCK ONT';
const SHEET_MONITORING = 'NTE MONITORING';
const SHEET_USER = 'USER';

// === Setup bot polling ===
const bot = new TelegramBot(TOKEN, { polling: true });

// === Setup Google Sheets API ===
const auth = new google.auth.GoogleAuth({
	scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
async function getSheetsClient() {
	return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// === Cek user di sheet USER ===
async function isUserAuthorized(username) {
	const sheets = await getSheetsClient();
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: SHEET_USER
	});
	const users = res.data.values || [];
	return users.some((row, i) =>
		i > 0 &&
		String(row[1] || '').trim().toUpperCase() === username.trim().toUpperCase() &&
		row[3] === 'AKTIF'
	);
}

// === Kirim pesan ke Telegram ===
function sendTelegram(chatId, text, options = {}) {
	return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
}

// === Notifikasi admin ===
function notifyAdmin(message) {
	if (ADMIN_CHAT_ID) sendTelegram(ADMIN_CHAT_ID, message);
}

// === Handler pesan masuk ===
bot.on('message', async (msg) => {
	const chatId = msg.chat.id;
	const username = msg.from.username ? '@' + msg.from.username : '-';
	const text = msg.text ? msg.text.trim() : '';

	if (text.toUpperCase() === '/MYID') {
		sendTelegram(chatId, `🆔 Chat ID Anda: <code>${chatId}</code>\nUsername: ${username}`);
		return;
	}

	if (text.toUpperCase() === '/PIVOT') {
		if (!(await isUserAuthorized(username))) {
			sendTelegram(chatId, '🚫 Akses ditolak. Anda tidak terdaftar.');
			return;
		}
		handlePivot(chatId);
		return;
	}

	if (text.startsWith('/')) {
		sendTelegram(chatId, '❓ Command tidak dikenali. Gunakan:\n• /myid - Lihat Chat ID\n• /pivot - Lihat rekap stock (perlu login)');
		return;
	}

	if (!text) {
		sendTelegram(chatId, '⚠️ Masukkan SN (ONT/STB/AP), bisa lebih dari 1 baris, atau gunakan command /pivot untuk melihat rekap.');
		return;
	}

	if (!(await isUserAuthorized(username))) {
		sendTelegram(chatId, '🚫 Akses ditolak. Anda tidak terdaftar.');
		notifyAdmin(`🚫 <b>AKSES DITOLAK</b>\n\nUser: ${username}\nChat ID: ${chatId}\nInput: ${text}\n\nWaktu: ${new Date().toLocaleString('id-ID')}`);
		return;
	}

	// Ambil semua SN dari input (dipisah per baris)
	const snList = text.toUpperCase().split("\n").map(sn => sn.trim()).filter(sn => sn !== "");
	const sheets = await getSheetsClient();
	const stockRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_STOCK });
	const stockData = stockRes.data.values || [];
	const monitoringRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_MONITORING });
	const monitoringData = monitoringRes.data.values || [];

	let results = [];

	for (const sn of snList) {
		const rowIndex = stockData.findIndex((row, i) =>
			i > 0 && (
				String(row[0]).trim().toUpperCase() === sn ||
				String(row[1]).trim().toUpperCase() === sn ||
				String(row[2]).trim().toUpperCase() === sn
			)
		);
		if (rowIndex === -1) {
			results.push(`❌ SN ${sn} tidak ditemukan di ${SHEET_STOCK}.`);
		} else {
			const rowData = stockData[rowIndex];
			const usedRow = monitoringData.find((row, i) =>
				i > 0 && (
					String(row[2]).trim().toUpperCase() === sn ||
					String(row[3]).trim().toUpperCase() === sn ||
					String(row[4]).trim().toUpperCase() === sn
				)
			);
			if (usedRow) {
				results.push(
					`⚠️ SN ${sn} sudah pernah digunakan!\n` +
					`➡️ Oleh: ${usedRow[1]} pada ${usedRow[0]}`
				);
			} else {
				// Simpan ke NTE MONITORING
				await sheets.spreadsheets.values.append({
					spreadsheetId: SHEET_ID,
					range: SHEET_MONITORING,
					valueInputOption: 'USER_ENTERED',
					requestBody: {
						values: [[
							new Date().toLocaleString('id-ID'),
							username,
							rowData[0], rowData[1], rowData[2], rowData[3], rowData[4], rowData[5], rowData[6],
							`TECHNISIAN - ${username}`
						]]
					}
				});
				// Update status di STOCK ONT
				await sheets.spreadsheets.values.update({
					spreadsheetId: SHEET_ID,
					range: `${SHEET_STOCK}!H${rowIndex + 1}`,
					valueInputOption: 'USER_ENTERED',
					requestBody: { values: [[`TECHNISIAN - ${username}`]] }
				});
				results.push(
					`✅ SN Ditemukan & disimpan:\n` +
					`SN ONT: ${rowData[0]}\n` +
					`SN STB: ${rowData[1]}\n` +
					`SN AP: ${rowData[2]}\n` +
					`NIK: ${rowData[3]}\n` +
					`OWNER: ${rowData[4]}\n` +
					`TYPE: ${rowData[5]}\n` +
					`SEKTOR: ${rowData[6]}\n` +
					`STATUS: TECHNISIAN - ${username}`
				);
			}
		}
	}

	sendTelegram(chatId, results.join("\n\n"));

	// Notifikasi admin
	if (ADMIN_CHAT_ID) {
		const successCount = results.filter(r => r.includes('✅')).length;
		const failedCount = results.filter(r => r.includes('❌')).length;
		const usedCount = results.filter(r => r.includes('⚠️')).length;
		let adminNotification = `📊 <b>AKTIVITAS USER</b>\n\n`;
		adminNotification += `👤 User: ${username}\n`;
		adminNotification += `🆔 Chat ID: ${chatId}\n`;
		adminNotification += `📅 Waktu: ${new Date().toLocaleString('id-ID')}\n\n`;
		adminNotification += `📝 <b>Input SN:</b>\n${snList.join(', ')}\n\n`;
		adminNotification += `📈 <b>Hasil:</b>\n`;
		adminNotification += `✅ Berhasil disimpan: ${successCount}\n`;
		adminNotification += `❌ Tidak ditemukan: ${failedCount}\n`;
		adminNotification += `⚠️ Sudah digunakan: ${usedCount}\n`;
		adminNotification += `📊 Total SN diproses: ${snList.length}`;
		notifyAdmin(adminNotification);
	}
});

// === Handler /pivot ===
async function handlePivot(chatId) {
	try {
		const sheets = await getSheetsClient();
		const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_STOCK });
		const data = res.data.values || [];
		const headers = data.shift();
		const idxSektor = headers.indexOf("SEKTOR");
		const idxOwner = headers.indexOf("OWNER");
		const idxType = headers.indexOf("TYPE");
		let pivot = {};
		data.forEach(row => {
			const sektor = row[idxSektor] || "-";
			const owner = row[idxOwner] || "-";
			const type = row[idxType] || "-";
			const status = String(row[7] || "").trim();
			if (!pivot[sektor]) pivot[sektor] = {};
			if (!pivot[sektor][owner]) pivot[sektor][owner] = {};
			if (!pivot[sektor][owner][type]) {
				pivot[sektor][owner][type] = { stock: 0, technisian: 0 };
			}
			if (status === "" || status === "-" || !status.includes("TECHNISIAN")) {
				pivot[sektor][owner][type].stock += 1;
			} else if (status.includes("TECHNISIAN")) {
				pivot[sektor][owner][type].technisian += 1;
			}
		});
		let text = "📊 <b>REKAP PIVOT STOCK & TECHNISIAN</b>\n\n";
		text += "<pre>";
		text += "SEKTOR     | OWNER  | TYPE | STOCK | TECH | TOTAL\n";
		text += "-----------+--------+------+-------+------+------\n";
		let grandTotalStock = 0;
		let grandTotalTech = 0;
		let grandTotal = 0;
		for (let sektor in pivot) {
			let sektorTotalStock = 0;
			let sektorTotalTech = 0;
			for (let owner in pivot[sektor]) {
				for (let type in pivot[sektor][owner]) {
					const { stock, technisian } = pivot[sektor][owner][type];
					const total = stock + technisian;
					sektorTotalStock += stock;
					sektorTotalTech += technisian;
					const sektorDisplay = sektor.length > 10 ? sektor.substring(0, 9) + "." : sektor.padEnd(10);
					const ownerDisplay = owner.length > 7 ? owner.substring(0, 6) + "." : owner.padEnd(7);
					const typeDisplay = type.length > 5 ? type.substring(0, 4) + "." : type.padEnd(5);
					text += `${sektorDisplay} | ${ownerDisplay} | ${typeDisplay} | ${String(stock).padStart(5)} | ${String(technisian).padStart(4)} | ${String(total).padStart(5)}\n`;
				}
			}
			const sektorTotal = sektorTotalStock + sektorTotalTech;
			text += `${sektor.padEnd(10)} | TOTAL  |      | ${String(sektorTotalStock).padStart(5)} | ${String(sektorTotalTech).padStart(4)} | ${String(sektorTotal).padStart(5)}\n`;
			text += "-----------+--------+------+-------+------+------\n";
			grandTotalStock += sektorTotalStock;
			grandTotalTech += sektorTotalTech;
			grandTotal += sektorTotal;
		}
		text += `GRAND TOTAL|        |      | ${String(grandTotalStock).padStart(5)} | ${String(grandTotalTech).padStart(4)} | ${String(grandTotal).padStart(5)}\n`;
		text += "</pre>\n\n";
		text += `📈 <b>Summary:</b>\n`;
		text += `• Total Stock Tersedia: ${grandTotalStock}\n`;
		text += `• Total Digunakan Technisian: ${grandTotalTech}\n`;
		text += `• Grand Total: ${grandTotal}`;
		sendTelegram(chatId, text, { parse_mode: 'HTML' });
	} catch (err) {
		sendTelegram(chatId, "❌ Error saat membuat pivot: " + err.toString());
	}
}

console.log('Bot ONT polling berjalan...');
