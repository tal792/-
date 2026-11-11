/**
 * Ashtal Yourpet – שמירת קבצים מצורפים מספקים ל-Google Drive
 * רץ אוטומטית כל שעה בחשבון Google של טל.
 * כל מייל עם התווית "ספקים" → הקבצים המצורפים נשמרים ב-Drive:
 *   Ashtal Yourpet – רכש / <שם הספק> / <שם הקובץ>
 * קובץ שכבר קיים באותו שם לא נשמר שוב.
 */
const LABEL = 'ספקים';
const ROOT = 'Ashtal Yourpet – רכש';
const NAMES = {
  'okeypets.com': 'OKEYPETS',
  'bestjoypet.com': 'Bestjoy',
  'ivytextile.com': 'Ivy Textile',
  'tianyuanpet.com': 'Petstar',
  'cnpreeminent.com': 'PamiPet',
  'ronipet.com': 'Ronipet',
  'hengshangtex.com': 'Hengshang',
  'nthengtuo.com': 'JCZCARE',
  'myjian.com': 'Myjian',
  'xykfoodgroup.com': 'Yantai Yummy',
  'xiantongfood.com': 'Rongchong',
  'petmex.pl': 'Petmex',
};

function saveSupplierAttachments() {
  const label = GmailApp.getUserLabelByName(LABEL);
  if (!label) return;
  const root = folder_(DriveApp.getRootFolder(), ROOT);
  label.getThreads(0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const from = msg.getFrom().toLowerCase();
      if (from.indexOf('bohadanatal') > -1) return; // skip our own emails
      const m = from.match(/@([a-z0-9.-]+)/);
      const domain = m ? m[1] : 'other';
      const folder = folder_(root, NAMES[domain] || domain);
      msg.getAttachments({ includeInlineImages: false }).forEach(function (att) {
        const name = att.getName();
        if (folder.getFilesByName(name).hasNext()) return;
        folder.createFile(att.copyBlob()).setName(name);
      });
    });
  });
}

function folder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** הרצה חד-פעמית: מגדיר הרצה אוטומטית כל שעה */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('saveSupplierAttachments').timeBased().everyHours(1).create();
  saveSupplierAttachments();
}
