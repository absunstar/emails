'use strict';
const words = require('../apps/emails/site_files/json/words-localized.json');
const lookup = new Map(words.map(row=>[row.name, row.En]));
function englishTemplate(source) {
 return String(source).replace(/##word\.(email_l_[a-f0-9]{12})##/g, (_,key)=>lookup.get(key)||key);
}
module.exports={englishTemplate};
