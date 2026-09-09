# Pro mailbox access update

Access matrix:

- Free app -> normal mailbox: allowed
- Free app -> Pro-only mailbox: blocked; one virtual Pro-required message returned
- Website -> normal mailbox: allowed
- Website -> Pro-only mailbox: blocked; one virtual Pro-required message returned
- VIP Temp Mail Pro -> normal mailbox: allowed
- VIP Temp Mail Pro -> Pro-only mailbox: allowed from any Pro installation

Mailbox ownerToken is no longer required for read access. It remains required by the secure destructive delete endpoint.
