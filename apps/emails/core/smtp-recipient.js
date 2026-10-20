'use strict';

// The transport envelope is authoritative for where incoming mail was delivered.
// RFC 5322 To/Cc headers are sender-controlled and cannot establish mailbox ownership.
function acceptedEnvelopeRecipients(session) {
    const list = Array.isArray(session?.envelope?.rcptTo) ? session.envelope.rcptTo : [];
    return [...new Set(list.map(recipient => String(recipient?.address || '').trim().toLowerCase())
        .filter(address => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)))];
}
module.exports = { acceptedEnvelopeRecipients };
