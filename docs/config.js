// Čísla na organizátory jsou v zašifrovaných datech týmů (src-data/common.json), ne tady.
export const CONFIG = {
  // Úkol 1 se zobrazí od tohoto času (čas zařízení).
  START: '2026-12-12T14:29:00',
  // Globální zprávy, text je base64 (UTF-8). Zakódování: node -e "console.log(Buffer.from('text').toString('base64'))"
  MESSAGES: [
    { at: '2026-12-12T17:15:00', text: 'U2lsbsOhIG7DoXBvdsSbZGEgayBmaW7DoWxlOiBIbGVkZWp0ZSBtZXppIHR5xI3DrWPDrW1pIHNlIGRvbXkuICh2em9yKQ==' },
    { at: '2026-12-12T17:30:00', text: 'TcOtc3RvIHNldGvDoW7DrTogaG9zcG9kYSBVIFpsYXTDqWhvIHR5Z3JhLCBIdXNvdmEgMTcuICh2em9yKQ==' },
  ],
};
