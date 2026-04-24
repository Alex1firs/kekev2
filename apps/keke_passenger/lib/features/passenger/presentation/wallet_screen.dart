import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../application/wallet_controller.dart';
import '../../auth/application/auth_controller.dart';
import '../domain/wallet_state.dart';
import 'paystack_webview.dart';

class WalletScreen extends ConsumerWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final walletState = ref.watch(walletControllerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('My Wallet')),
      body: RefreshIndicator(
        onRefresh: () => ref.read(walletControllerProvider.notifier).refresh(),
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _buildBalanceCard(context, ref, walletState)),
            const SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20, 32, 20, 16),
                child: Text('Transaction History', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              ),
            ),
            _buildHistoryList(walletState),
          ],
        ),
      ),
    );
  }

  Widget _buildBalanceCard(BuildContext context, WidgetRef ref, WalletState state) {
    return Container(
      margin: const EdgeInsets.all(20),
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.amber,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [BoxShadow(color: Colors.amber.withOpacity(0.3), blurRadius: 12, offset: const Offset(0, 6))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Available Balance', style: TextStyle(color: Colors.black54, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(
            '₦${NumberFormat('#,###.00').format(state.balance)}',
            style: const TextStyle(fontSize: 32, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 24),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.black,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () => _showTopupDialog(context, ref),
            child: const Text('Fund Wallet'),
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryList(WalletState state) {
    if (state.isLoading && state.history.isEmpty) {
      return const SliverFillRemaining(child: Center(child: CircularProgressIndicator()));
    }

    if (state.history.isEmpty) {
      return const SliverToBoxAdapter(
        child: Center(
          child: Padding(
            padding: EdgeInsets.only(top: 100),
            child: Text('No transactions yet.', style: TextStyle(color: Colors.grey)),
          ),
        ),
      );
    }

    return SliverList(
      delegate: SliverChildBuilderDelegate(
        (context, index) {
          final tx = state.history[index];
          final isCredit = tx.amount > 0;

          return ListTile(
            leading: CircleAvatar(
              backgroundColor: isCredit ? Colors.green.shade50 : Colors.red.shade50,
              child: Icon(isCredit ? Icons.add : Icons.remove, color: isCredit ? Colors.green : Colors.red),
            ),
            title: Text(tx.description),
            subtitle: Text(DateFormat('MMM dd, yyyy • HH:mm').format(tx.date)),
            trailing: Text(
              '${isCredit ? "+" : ""}₦${tx.amount.abs().toStringAsFixed(0)}',
              style: TextStyle(fontWeight: FontWeight.bold, color: isCredit ? Colors.green : Colors.red),
            ),
          );
        },
        childCount: state.history.length,
      ),
    );
  }

  void _showTopupDialog(BuildContext context, WidgetRef ref) {
    final controller = TextEditingController();
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Fund Wallet'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Amount (₦)', hintText: 'e.g. 5000'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () async {
              final amount = double.tryParse(controller.text);
              final authState = ref.read(authControllerProvider);
              String email = 'user@keke.app';
              
              if (authState.token != null) {
                try {
                  final decoded = JwtDecoder.decode(authState.token!);
                  final phone = decoded['phone']?.toString();
                  if (phone != null) {
                    email = '$phone@keke.app';
                  }
                } catch (e) {
                  print('[WALLET_ERROR] Email derivation failed: $e');
                }
              }

              if (amount != null && amount > 0) {
                Navigator.pop(context);
                final url = await ref.read(walletControllerProvider.notifier)
                    .initializeTopup(amount, email); 
                if (url != null) {
                   Navigator.push(
                    context,
                    MaterialPageRoute(builder: (context) => PaystackWebView(url: url)),
                  ).then((success) {
                    if (success == true) {
                       ref.read(walletControllerProvider.notifier).refresh();
                    }
                  });
                }
              }
            },
            child: const Text('Proceed'),
          ),
        ],
      ),
    );
  }
}
