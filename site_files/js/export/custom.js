function string_to_buffer(s) {
  if (typeof ArrayBuffer !== "undefined") {
    var buf = new ArrayBuffer(s.length);
    var view = new Uint8Array(buf);
    for (var i = 0; i != s.length; ++i) view[i] = s.charCodeAt(i) & 0xff;
    return buf;
  } else {
    var buf = new Array(s.length);
    for (var i = 0; i != s.length; ++i) buf[i] = s.charCodeAt(i) & 0xff;
    return buf;
  }
}

function export_to_xlsx(id, _fileName) {
    _fileType = 'xlsx';
  var workbook  = XLSX.utils.table_to_book(document.getElementById(id), {sheet: "Sheet JS"});
  /*console.log(workbook.Sheets['Sheet JS']['B2'].v)*/
  var wbout = XLSX.write(workbook , {bookType: _fileType, bookSST: true, type: "binary"});
  var fileName = _fileName || "file." + _fileType;
  try {
    saveAs(new Blob([string_to_buffer(wbout)], {type: "application/octet-stream"}) , fileName);
  } catch (e) {
    if (typeof console != "undefined") console.log(e);
  }
  return wbout;
}
