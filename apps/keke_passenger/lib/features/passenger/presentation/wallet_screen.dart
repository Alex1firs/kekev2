import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../../../core/theme/app_theme.dart';
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
      backgroundColor: AppColors.snow,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        foregroundColor: AppColors.white,
        elevation: 0,
        title: Text('My Wallet', style: AppTextStyles.title(color: AppColors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(walletControllerProvider.notifier).refresh(),
        color: AppColors.primary,
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(
              child: _buildBalanceCard(context, ref, walletState),
            ),
            SliverToBoxAdapter(child: _buildSectionHeader('Transaction History')),
            _buildHistoryList(walletState),
            const SliverToBoxAdapter(child: SizedBox(height: 32)),
          ],
        ),
      ),
    );
  }

  Widget _buildBalanceCard(BuildContext context, WidgetRef ref, WalletState state) {
    return Container(
      margin: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppColors.charcoal, Color(0xFF1F2937)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(24),
        boxShadow: const [
          BoxShadow(
            color: Color(0x30000000),
            blurRadius: 16,
            offset: Offset(0, 6),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.2),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(
                    Icons.account_balance_wallet_outlined,
                    color: AppColors.primary,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  'Keke Wallet',
                  style: AppTextStyles.body(color: AppColors.lightGray),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text(
              'Available Balance',
              style: AppTextStyles.bodySmall(color: AppColors.midGray),
            ),
            const SizedBox(height: 6),
            Text(
              '₦${NumberFormat('#,###.00').format(state.balance)}',
              style: AppTextStyles.display(color: AppColors.white, weight: FontWeight.w800),
            ),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: AppColors.charcoal,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  elevation: 0,
                ),
                onPressed: () => _showTopupDialog(context, ref),
                icon: const Icon(Icons.add_rounded, size: 20),
                label: Text(
                  'Fund Wallet',
                  style: AppTextStyles.body(
                    color: AppColors.charcoal,
                    weight: FontWeight.w700,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
      child: Text(title, style: AppTextStyles.title(color: AppColors.charcoal)),
    );
  }

  Widget _buildHistoryList(WalletState state) {
    if (state.isLoading && state.history.isEmpty) {
      return const SliverFillRemaining(
        child: Center(
          child: CircularProgressIndicator(color: AppColors.primary),
        ),
      );
    }

    if (state.history.isEmpty) {
      return SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.only(top: 60),
          child: Column(
            children: [
              const Icon(Icons.receipt_long_outlined, color: AppColors.border, size: 52),
              const SizedBox(height: 12),
              Text('No transactions yet', style: AppTextStyles.body(color: AppColors.lightGray)),
              const SizedBox(height: 6),
              Text(
                'Fund your wallet to start riding',
                style: AppTextStyles.bodySmall(color: AppColors.lightGray),
              ),
            ],
          ),
        ),
      );
    }

    return SliverList(
      delegate: SliverChildBuilderDelegate(
        (context, index) {
          final tx = state.history[index];
          final isCredit = tx.amount > 0;

          return Container(
            margin: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: BoxDecoration(
              color: AppColors.white,
              borderRadius: BorderRadius.circular(14),
              boxShadow: const [
                BoxShadow(color: Color(0x08000000), blurRadius: 6, offset: Offset(0, 2)),
              ],
            ),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: isCredit
                        ? const Color(0xFFD1FAE5)
                        : const Color(0xFFFEE2E2),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    isCredit ? Icons.add_rounded : Icons.remove_rounded,
                    color: isCredit ? AppColors.success : AppColors.error,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        tx.description,
                        style: AppTextStyles.body(
                          color: AppColors.charcoal,
                          weight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        DateFormat('MMM dd, yyyy • HH:mm').format(tx.date),
                        style: AppTextStyles.caption(color: AppColors.midGray),
                      ),
                    ],
                  ),
                ),
                Text(
                  '${isCredit ? "+" : ""}₦${tx.amount.abs().toStringAsFixed(0)}',
                  style: AppTextStyles.body(
                    color: isCredit ? AppColors.success : AppColors.error,
                    weight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          );
        },
        childCount: state.history.length,
      ),
    );
  }

  void _showTopupDialog(BuildContext context, WidgetRef ref) {
    final amountController = TextEditingController();
    final emailController = TextEditingController();

    final authState = ref.read(authControllerProvider);
    if (authState.token != null) {
      try {
        final decoded = JwtDecoder.decode(authState.token!);
        final phone = decoded['phone']?.toString();
        if (phone != null) emailController.text = '$phone@keke.app';
      } catch (_) {}
    }

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text('Fund Wallet', style: AppTextStyles.title(color: AppColors.charcoal)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: amountController,
              keyboardType: TextInputType.number,
              style: AppTextStyles.body(color: AppColors.charcoal),
              decoration: const InputDecoration(
                labelText: 'Amount (₦)',
                hintText: 'e.g. 5000',
                prefixIcon: Icon(Icons.payments_outlined),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: emailController,
              keyboardType: TextInputType.emailAddress,
              style: AppTextStyles.body(color: AppColors.charcoal),
              decoration: const InputDecoration(
                labelText: 'Email (for receipt)',
                hintText: 'Optional',
                prefixIcon: Icon(Icons.email_outlined),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: AppTextStyles.body(color: AppColors.midGray)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: AppColors.charcoal,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () async {
              final amount = double.tryParse(amountController.text);
              if (amount == null || amount <= 0) return;

              final email = emailController.text.trim().isNotEmpty
                  ? emailController.text.trim()
                  : 'user@keke.app';

              Navigator.pop(ctx);
              final url = await ref
                  .read(walletControllerProvider.notifier)
                  .initializeTopup(amount, email);

              if (url != null && context.mounted) {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => PaystackWebView(url: url),
                  ),
                ).then((success) {
                  if (success == true) {
                    ref.read(walletControllerProvider.notifier).refresh();
                  }
                });
              }
            },
            child: Text('Proceed', style: AppTextStyles.body(weight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}
