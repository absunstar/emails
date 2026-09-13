import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vip_temp_mails/config/app_config.dart';
import 'package:vip_temp_mails/models/email_model.dart';
import 'package:vip_temp_mails/providers/email_provider.dart';

void main() {
  test('free edition keeps 100 limit and defines the lifetime Pro product', () {
    expect(AppConfig.appName, 'VIP Temp Mail');
    expect(AppConfig.maxSavedEmails, 100);
    expect(AppConfig.proProductId, 'vip_temp_mail_pro_lifetime');
  });


  test('Pro entitlement removes the saved-email limit and allows saved mailbox deletion', () async {
    final saved = List.generate(
      100,
      (index) => {'email': 'pro$index@egytag.com'},
    );
    SharedPreferences.setMockInitialValues({
      'saved_accounts': jsonEncode(saved),
    });

    final provider = EmailProvider();
    await provider.initialize();
    expect(provider.hasReachedLimit, isTrue);

    provider.setProEntitlement(true);
    expect(provider.isPro, isTrue);
    expect(provider.hasReachedLimit, isFalse);

    final deleted = await provider.deleteSavedAccount(provider.savedAccounts.first);
    expect(deleted, isTrue);
    expect(provider.savedCount, 99);
  });

  test('account model preserves mailbox text', () {
    const account = Account(email: 'custom.mailbox@egytag.com');
    expect(Account.fromJson(account.toJson()), account);
  });

  test('manual mailbox validation only accepts @egytag.com', () {
    expect(EmailProvider.isAllowedMailbox('user@egytag.com'), isTrue);
    expect(EmailProvider.isAllowedMailbox('USER@EGYTAG.COM'), isTrue);
    expect(EmailProvider.isAllowedMailbox('user@example.com'), isFalse);
    expect(EmailProvider.isAllowedMailbox('user@sub.egytag.com'), isFalse);
    expect(EmailProvider.isAllowedMailbox('user@egytag.com.evil.test'), isFalse);
    expect(EmailProvider.isAllowedMailbox('@egytag.com'), isFalse);
    expect(EmailProvider.isAllowedMailbox('user@@egytag.com'), isFalse);
  });

  test('message parser accepts numeric string ids and missing dates', () {
    final message = Message.fromJson({
      'id': '42',
      'from': 'sender@example.com',
      'subject': 'Hello',
    });
    expect(message.id, 42);
    expect(message.date, isNull);
  });


  test('message parser preserves guid for web-compatible detail lookup', () {
    final message = Message.fromJson({
      'id': '42',
      'guid': 'mail-guid-42',
      'from': 'sender@example.com',
    });
    expect(message.id, 42);
    expect(message.guid, 'mail-guid-42');
  });

  test('upgrade preserves legacy users with more than 100 saved emails', () async {
    final legacy = List.generate(
      125,
      (index) => {'email': 'legacy$index@example.com'},
    );
    final raw = jsonEncode(legacy);
    SharedPreferences.setMockInitialValues({'saved_accounts': raw});

    final provider = EmailProvider();
    await provider.initialize();

    expect(provider.savedCount, 125);
    expect(provider.hasReachedLimit, isTrue);
    expect(provider.currentAccount?.email, 'legacy0@example.com');

    final prefs = await SharedPreferences.getInstance();
    expect(
      prefs.getString('saved_accounts_backup_before_free_limit_v1'),
      raw,
    );
  });

  test('over-limit legacy user can open existing email but cannot add a new one', () async {
    final legacy = List.generate(
      101,
      (index) => {'email': 'kept$index@egytag.com'},
    );
    SharedPreferences.setMockInitialValues({
      'saved_accounts': jsonEncode(legacy),
    });

    final provider = EmailProvider();
    await provider.initialize();

    await provider.openMailbox('kept100@egytag.com');
    expect(provider.currentAccount?.email, 'kept100@egytag.com');
    expect(provider.savedCount, 101);

    await expectLater(
      provider.openMailbox('new-address@egytag.com'),
      throwsA(isA<EmailLimitException>()),
    );
    expect(provider.savedCount, 101);
  });

  test('editing the visible email then opening creates a new saved mailbox without modifying the current one', () async {
    SharedPreferences.setMockInitialValues({
      'saved_accounts': jsonEncode([
        {'email': 'first@egytag.com'},
      ]),
    });

    final provider = EmailProvider();
    await provider.initialize();

    expect(provider.currentAccount?.email, 'first@egytag.com');
    expect(provider.savedCount, 1);

    await provider.openMailbox('second@egytag.com');

    expect(provider.currentAccount?.email, 'second@egytag.com');
    expect(provider.savedCount, 2);
    expect(
      provider.savedAccounts.map((account) => account.email),
      containsAll(<String>['first@egytag.com', 'second@egytag.com']),
    );
  });

  test('opening an already saved mailbox does not create a duplicate or consume another slot', () async {
    SharedPreferences.setMockInitialValues({
      'saved_accounts': jsonEncode([
        {'email': 'first@egytag.com'},
        {'email': 'second@egytag.com'},
      ]),
    });

    final provider = EmailProvider();
    await provider.initialize();

    await provider.openMailbox('second@egytag.com');

    expect(provider.currentAccount?.email, 'second@egytag.com');
    expect(provider.savedCount, 2);
    expect(
      provider.savedAccounts.where((account) => account.email == 'second@egytag.com').length,
      1,
    );
  });

  test('at exactly 100 saved mailboxes changing the email cannot replace the current mailbox', () async {
    final saved = List.generate(
      AppConfig.maxSavedEmails,
      (index) => {'email': 'saved$index@egytag.com'},
    );
    SharedPreferences.setMockInitialValues({
      'saved_accounts': jsonEncode(saved),
    });

    final provider = EmailProvider();
    await provider.initialize();
    final originalCurrent = provider.currentAccount?.email;

    await expectLater(
      provider.openMailbox('mailbox-101@egytag.com'),
      throwsA(isA<EmailLimitException>()),
    );

    expect(provider.savedCount, AppConfig.maxSavedEmails);
    expect(provider.currentAccount?.email, originalCurrent);
    expect(
      provider.savedAccounts.any((account) => account.email == 'mailbox-101@egytag.com'),
      isFalse,
    );
  });


  test('provider rejects adding a mailbox outside @egytag.com', () async {
    SharedPreferences.setMockInitialValues({
      'saved_accounts': jsonEncode([
        {'email': 'current@egytag.com'},
      ]),
    });

    final provider = EmailProvider();
    await provider.initialize();

    await expectLater(
      provider.openMailbox('blocked@example.com'),
      throwsA(isA<FormatException>()),
    );

    expect(provider.savedCount, 1);
    expect(provider.currentAccount?.email, 'current@egytag.com');
    expect(
      provider.savedAccounts.any((account) => account.email == 'blocked@example.com'),
      isFalse,
    );
  });

}
