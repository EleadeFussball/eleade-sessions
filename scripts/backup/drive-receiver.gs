// Google Apps Script web app. Receives the nightly backup from GitHub and overwrites one Drive file.
// Script properties required: BACKUP_SECRET (password), DRIVE_FILE_ID (id of the .xlsx).
// Requires the Advanced Drive service (Services > Drive API, v3).
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body = JSON.parse(e.postData.contents);
  if (!body.secret || body.secret !== props.getProperty('BACKUP_SECRET')) {
    return ContentService.createTextOutput('DENIED');
  }
  var bytes = Utilities.base64Decode(body.data);
  var blob = Utilities.newBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'eleade-backup.xlsx');
  Drive.Files.update({}, props.getProperty('DRIVE_FILE_ID'), blob);
  return ContentService.createTextOutput('OK ' + bytes.length + ' bytes at ' + new Date().toISOString());
}
function doGet() { return ContentService.createTextOutput('Eleade backup receiver is running'); }
