#!/usr/bin/env python3
import json, os, smtplib, sys, time, urllib.parse, urllib.request, uuid

origin = (os.getenv("TEMP_MAIL_SMOKE_ORIGIN") or (sys.argv[1] if len(sys.argv) > 1 else "https://emails.egytag.com")).rstrip("/")
smtp_host = os.getenv("TEMP_MAIL_SMOKE_SMTP_HOST", "127.0.0.1")
smtp_port = int(os.getenv("TEMP_MAIL_SMOKE_SMTP_PORT", "25"))
timeout = int(os.getenv("TEMP_MAIL_SMOKE_TIMEOUT", "15"))

def post(path, payload, base=None, headers=None):
    url = (base or origin) + path
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json", **(headers or {})}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)

def get(path):
    with urllib.request.urlopen(origin + path, timeout=timeout) as response:
        return response.status, response.headers.get("content-type", ""), response.read()

def main():
    marker = uuid.uuid4().hex[:12]
    subject = "TEMP-MAIL-SMOKE-" + marker
    generated = post("/generate-new-email", {})
    if not generated.get("done") or not generated.get("email"):
        raise RuntimeError("mailbox generation failed: " + repr(generated))
    email = generated["email"]

    message = (
        "From: temp-mail-smoke@example.net\r\n"
        "To: " + email + "\r\n"
        "Subject: " + subject + "\r\n"
        "Message-ID: <smoke-" + marker + "@example.net>\r\n"
        "Date: " + __import__("email.utils").utils.formatdate(localtime=False, usegmt=True) + "\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n\r\n"
        "Production smoke check " + marker + "\r\n"
    ).encode("utf-8")
    with smtplib.SMTP(smtp_host, smtp_port, timeout=timeout) as smtp:
        smtp.sendmail("temp-mail-smoke@example.net", [email], message)

    found = None
    for _ in range(15):
        inbox = post("/api/emails/all", {
            "where": {"to": email},
            "email": email,
            "exactTo": True,
            "limit": 20,
            "select": {"text": True},
        })
        found = next((m for m in inbox.get("list", []) if m.get("subject") == subject), None)
        if found:
            break
        time.sleep(1)
    if not found:
        raise RuntimeError("SMTP message did not appear in public inbox")

    by_id = post("/api/emails/view", {"id": found["id"], "email": email, "to": email})
    if not by_id.get("done") or by_id.get("guid") != found.get("guid") or by_id.get("subject") != subject:
        raise RuntimeError("legacy numeric-id mobile view failed: " + repr(by_id))

    by_guid = post("/api/emails/view", {"guid": found["guid"], "email": email, "to": email})
    if not by_guid.get("done") or by_guid.get("guid") != found.get("guid") or by_guid.get("subject") != subject:
        raise RuntimeError("GUID mobile view failed: " + repr(by_guid))

    mobile_handoff = email.lower().endswith("@egytag.com")
    qr_params = {"email": email}
    if mobile_handoff:
        qr_params["handoff"] = "1"
    qr_path = "/api/emails/qr?" + urllib.parse.urlencode(qr_params)
    qr_status, qr_type, _ = get(qr_path)
    if qr_status != 200 or "image/svg+xml" not in qr_type:
        raise RuntimeError("QR handoff failed")

    open_status, _, open_body = get("/o")
    open_text = open_body.decode("utf-8", "ignore")
    if open_status != 200 or "viptempmail://open#email=" not in open_text or "com.egytag.mails" not in open_text:
        raise RuntimeError("mobile handoff page failed")

    cleanup = None
    try:
        cleanup = post(
            "/api/emails/admin/delete",
            {"guid": found["guid"]},
            base="http://127.0.0.1:60025",
            headers={"x-browser": "admin-test"},
        )
    except Exception as exc:
        cleanup = {"done": False, "error": str(exc)}

    print(json.dumps({
        "ok": True,
        "origin": origin,
        "email": email,
        "domain": generated.get("domain"),
        "messageId": found.get("id"),
        "guid": found.get("guid"),
        "legacyResolvedBy": by_id.get("resolvedBy", ""),
        "qr": True,
        "mobileHandoff": mobile_handoff,
        "deepLinkPage": True,
        "packageName": "com.egytag.mails",
        "cleanup": cleanup,
    }, indent=2))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("TEMP_MAIL_PRODUCTION_SMOKE_FAIL", str(exc), file=sys.stderr)
        raise
