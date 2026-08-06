import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keke_passenger/core/network/api_client.dart';
import 'package:keke_passenger/features/passenger/data/communication_preferences_repository.dart';
import 'package:keke_passenger/features/passenger/presentation/widgets/communication_opt_in_prompt.dart';

/// What the prompt must never become.
///
/// The golden image proves the layout; these prove the properties that make it
/// an honest ask rather than a dark pattern — and those are the ones a future
/// redesign is most likely to erode.
void main() {
  Widget harness() => MaterialApp(
        home: Scaffold(
          body: CommunicationOptInSheet(
            repo: CommunicationPreferencesRepository(ApiClient(Dio())),
          ),
        ),
      );

  testWidgets('offers accept, decline and manage-preferences', (tester) async {
    await tester.pumpWidget(harness());
    expect(find.text('Yes, keep me updated'), findsOneWidget);
    expect(find.text('Not now'), findsOneWidget);
    expect(find.text('Manage preferences'), findsOneWidget);
  });

  /*
   * The decline must be as easy to hit as the accept. Consent extracted by
   * making refusal awkward produces spam complaints, and a complaint costs the
   * sending domain that also carries verification codes.
   */
  testWidgets('decline is the same height as accept', (tester) async {
    await tester.pumpWidget(harness());
    final accept = tester.getSize(find.ancestor(
        of: find.text('Yes, keep me updated'), matching: find.byType(SizedBox)).first);
    final decline = tester.getSize(find.ancestor(
        of: find.text('Not now'), matching: find.byType(SizedBox)).first);
    expect(decline.height, accept.height);
  });

  testWidgets('says essential messages still arrive', (tester) async {
    await tester.pumpWidget(harness());
    // The commonest reason to refuse is fearing you will lose something you
    // need. Saying otherwise is what makes a free choice possible.
    expect(
      find.textContaining('verification codes are always sent'),
      findsOneWidget,
    );
  });

  testWidgets('does not claim the offer is time-limited or scarce', (tester) async {
    await tester.pumpWidget(harness());
    for (final manipulative in ['Last chance', 'Don\'t miss', 'Only today', 'Hurry']) {
      expect(find.textContaining(manipulative), findsNothing);
    }
  });
}
