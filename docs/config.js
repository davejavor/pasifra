// Čísla na organizátory jsou v zašifrovaných datech týmů (src-data/common.json), ne tady.
export const CONFIG = {
  // Úkol 1 se zobrazí od tohoto času (čas zařízení).
  START: '2026-12-12T14:29:00',
  // Globální zprávy, text je base64 (UTF-8). Zakódování: node -e "console.log(Buffer.from('text').toString('base64'))"
  MESSAGES: [
    { at: '2026-12-12T17:15:00', text: 'U2lsbsOhIG7DoXBvdsSbZGEgcHJvIHbFoWVjaG55OiBmaW7DoWxlIHNlIGtvbsOhIG5hIE1hbMOpIFN0cmFuxJssIHUgcGFsw6FjZSB2b2pldsWvZGNlIHTFmWljZXRpbGV0w6kgdsOhbGt5LiBLZG8gdcW+IG3DoSDDunRyxb5laywgYcWlIHRhbSB2eXJhesOtLg==' },
    { at: '2026-12-12T17:30:00', text: 'U3JheiB2xaFlY2ggdMO9bcWvIGplIHRlxI8gcMWZZWQgVmFsZMWhdGVqbnNrw71tIHBhbMOhY2VtIG5hIFZhbGTFoXRlam5za8OpbSBuw6FtxJtzdMOtLiBQxZlpasSPdGUgaSBiZXogdnnFmWXFoWVuw6lobyDDumtvbHUu' },
    { at: '2026-12-12T17:55:00', text: 'SHJhIGtvbsSNw60sIHZlxI3DrXJlayB6YcSNw61uw6E6IHbFoWljaG5pIGRvIEtyxI1teSBVIEtyw6FsZSBCcmFiYW50c2vDqWhvLCBUaHVub3Zza8OhIDE1LiDEjGVrw6FtZSBuYSB2w6FzIQ==' },
  ],
};
