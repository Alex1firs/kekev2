import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../../../core/theme/app_theme.dart';
import '../application/driver_finance_controller.dart';
import '../domain/driver_finance_state.dart';
import '../../auth/application/auth_controller.dart';
import 'paystack_webview.dart';
import 'trip_history_screen.dart';

class EarningsScreen extends ConsumerStatefulWidget {
  const EarningsScreen({super.key});

  @override
  ConsumerState<EarningsScreen> createState() => _EarningsScreenState();
}

class _EarningsScreenState extends ConsumerState<EarningsScreen> {
  @override
  Widget build(BuildContext context) {
    final financeState = ref.watch(driverFinanceControllerProvider);

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        foregroundColor: AppColors.white,
        elevation: 0,
        title: Text('Earnings & Finance', style: AppTextStyles.title(color: AppColors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(driverFinanceControllerProvider.notifier).refresh(),
        color: AppColors.primary,
        backgroundColor: AppColors.darkGray,
        child: CustomScrollView(
          slivers: [
            if (financeState.commissionDebt >= 1000)
              SliverToBoxAdapter(child: _buildDebtAlert(financeState)),
            SliverToBoxAdapter(child: _buildBalanceCards(financeState)),
            SliverToBoxAdapter(child: _buildActionRow(financeState)),
            SliverToBoxAdapter(child: _buildHistoryHeader()),
            _buildHistoryList(financeState),
            const SliverToBoxAdapter(child: SizedBox(height: 32)),
          ],
        ),
      ),
    );
  }

  Widget _buildDebtAlert(DriverFinanceState state) {
    Color borderColor;
    Color bgColor;
    Color fgColor;
    String title;
    String message;

    if (state.commissionDebt >= 5000) {
      borderColor = AppColors.error;
      bgColor = const Color(0xFF3B0A0A);
      fgColor = const Color(0xFFFCA5A5);
      title = 'Account Blocked';
      message = 'Debt ₦${state.commissionDebt.toStringAsFixed(0)} exceeds limit. Clear debt to go online.';
    } else if (state.commissionDebt >= 2000) {
      borderColor = const Color(0xFFEA580C);
      bgColor = const Color(0xFF3B1A0A);
      fgColor = const Color(0xFFFBBF24);
      title = 'Cash Rides Blocked';
      message = 'Debt ₦${state.commissionDebt.toStringAsFixed(0)} — wallet rides available. Top up to restore cash.';
    } else {
      borderColor = AppColors.primary;
      bgColor = const Color(0xFF3B2A00);
      fgColor = AppColors.primary;
      title = 'Debt Warning';
      message = '₦${state.commissionDebt.toStringAsFixed(0)} owed to platform. Top up wallet to clear.';
    }

    return Container(
      margin: const EdgeInsets.fromLTRB(20, 20, 20, 0),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: borderColor),
      ),
      child: Row(
        children: [
          Icon(Icons.warning_amber_rounded, color: fgColor, size: 28),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: AppTextStyles.body(color: fgColor, weight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(message, style: AppTextStyles.bodySmall(color: fgColor.withOpacity(0.8))),
              ],
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: () => _handlePayNow(state),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: fgColor.withOpacity(0.15),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: fgColor.withOpacity(0.4)),
              ),
              child: Text('Pay Now', style: AppTextStyles.bodySmall(color: fgColor, weight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBalanceCards(DriverFinanceState state) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 0),
      child: Row(
        children: [
          Expanded(
            child: _BalanceCard(
              label: 'Available',
              amount: state.availableBalance,
              color: AppColors.success,
              icon: Icons.account_balance_wallet_outlined,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _BalanceCard(
              label: 'Pending',
              amount: state.pendingBalance,
              color: AppColors.lightGray,
              icon: Icons.hourglass_top_rounded,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActionRow(DriverFinanceState state) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.white,
                    foregroundColor: AppColors.charcoal,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    elevation: 0,
                  ),
                  onPressed: state.availableBalance > 0 ? () => _showPayoutDialog(state) : null,
                  child: Text('Request Payout', style: AppTextStyles.body(weight: FontWeight.w700)),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: AppColors.charcoal,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    elevation: 0,
                  ),
                  onPressed: () => _showTopUpDialog(),
                  child: Text('Top Up Wallet', style: AppTextStyles.body(weight: FontWeight.w700)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.lightGray,
              side: const BorderSide(color: AppColors.darkGray),
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            ),
            onPressed: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const DriverTripHistoryScreen())),
            icon: const Icon(Icons.history_rounded, size: 18),
            label: Text('Trip History', style: AppTextStyles.body(color: AppColors.lightGray)),
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 32, 20, 12),
      child: Text(
        'Recent Transactions',
        style: AppTextStyles.title(color: AppColors.white),
      ),
    );
  }

  Widget _buildHistoryList(DriverFinanceState state) {
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
          padding: const EdgeInsets.only(top: 48),
          child: Column(
            children: [
              const Icon(Icons.receipt_long_outlined, color: AppColors.darkGray, size: 48),
              const SizedBox(height: 12),
              Text('No transactions yet', style: AppTextStyles.body(color: AppColors.midGray)),
            ],
          ),
        ),
      );
    }

    return SliverList(
      delegate: SliverChildBuilderDelegate(
        (context, index) {
          final entry = state.history[index];
          final isCredit = entry.amount > 0;

          return Container(
            margin: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: AppColors.darkGray,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: isCredit
                        ? AppColors.success.withOpacity(0.15)
                        : AppColors.error.withOpacity(0.15),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    isCredit ? Icons.arrow_downward_rounded : Icons.arrow_upward_rounded,
                    color: isCredit ? AppColors.success : AppColors.error,
                    size: 18,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.description,
                        style: AppTextStyles.body(color: AppColors.white),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        _formatDate(entry.date),
                        style: AppTextStyles.caption(color: AppColors.midGray),
                      ),
                    ],
                  ),
                ),
                Text(
                  '${isCredit ? "+" : ""}₦${entry.amount.abs().toStringAsFixed(0)}',
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

  String _formatDate(DateTime dt) {
    final now = DateTime.now();
    final diff = now.difference(dt);
    if (diff.inDays == 0) {
      return 'Today ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    }
    if (diff.inDays == 1) return 'Yesterday';
    if (diff.inDays < 7) return '${diff.inDays}d ago';
    return '${dt.day}/${dt.month}/${dt.year}';
  }

  Future<void> _showPayoutDialog(DriverFinanceState state) async {
    final bankCodeCtrl = TextEditingController();
    final accountNumCtrl = TextEditingController();
    final amountCtrl = TextEditingController(
        text: state.availableBalance.toStringAsFixed(0));

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => _buildDarkDialog(
        ctx: ctx,
        title: 'Request Payout',
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Available: ₦${state.availableBalance.toStringAsFixed(2)}',
              style: AppTextStyles.bodySmall(color: AppColors.success),
            ),
            const SizedBox(height: 16),
            _DarkField(controller: amountCtrl, label: 'Amount (₦)', type: TextInputType.number),
            const SizedBox(height: 12),
            _DarkField(controller: bankCodeCtrl, label: 'Bank Code (e.g. 058)', type: TextInputType.number),
            const SizedBox(height: 12),
            _DarkField(controller: accountNumCtrl, label: 'Account Number', type: TextInputType.number),
            const SizedBox(height: 10),
            Text(
              'Requests are reviewed by the platform team before transfer.',
              style: AppTextStyles.caption(color: AppColors.midGray),
            ),
          ],
        ),
        confirmLabel: 'Submit Request',
      ),
    );

    if (confirmed != true || !mounted) return;

    final amount = double.tryParse(amountCtrl.text.trim()) ?? 0;
    final bankCode = bankCodeCtrl.text.trim();
    final accountNum = accountNumCtrl.text.trim();

    if (amount <= 0 || bankCode.isEmpty || accountNum.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('All fields are required')),
      );
      return;
    }

    final success = await ref
        .read(driverFinanceControllerProvider.notifier)
        .initiatePayout(amount, bankCode, accountNum);

    if (!mounted) return;
    if (success) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: AppColors.success,
          content: Text('Payout request submitted!',
              style: AppTextStyles.body(color: AppColors.white)),
        ),
      );
    }
  }

  Future<void> _handlePayNow(DriverFinanceState state) async {
    final controller = ref.read(driverFinanceControllerProvider.notifier);

    if (state.availableBalance > 0 && state.commissionDebt > 0) {
      final applied = await controller.repayDebt();
      if (!mounted) return;

      final remaining = ref.read(driverFinanceControllerProvider).commissionDebt;
      if (remaining <= 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            backgroundColor: AppColors.success,
            content: Text('₦${applied.toStringAsFixed(0)} applied — debt cleared!',
                style: AppTextStyles.body(color: AppColors.white)),
          ),
        );
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: AppColors.primary,
          content: Text(
            '₦${applied.toStringAsFixed(0)} applied. ₦${remaining.toStringAsFixed(0)} remaining.',
            style: AppTextStyles.body(color: AppColors.charcoal),
          ),
        ),
      );
    }

    _showTopUpDialog();
  }

  Future<void> _showTopUpDialog() async {
    final amountCtrl = TextEditingController();
    final emailCtrl = TextEditingController();

    final authState = ref.read(authControllerProvider);
    if (authState.token != null) {
      try {
        final decoded = JwtDecoder.decode(authState.token!);
        final phone = decoded['phone']?.toString();
        if (phone != null) emailCtrl.text = '$phone@keke.app';
      } catch (_) {}
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => _buildDarkDialog(
        ctx: ctx,
        title: 'Top Up Wallet',
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _DarkField(controller: amountCtrl, label: 'Amount (₦)', type: TextInputType.number),
            const SizedBox(height: 12),
            _DarkField(controller: emailCtrl, label: 'Email (for receipt)', type: TextInputType.emailAddress),
          ],
        ),
        confirmLabel: 'Proceed to Payment',
        confirmColor: AppColors.primary,
        confirmFgColor: AppColors.charcoal,
      ),
    );

    if (confirmed != true || !mounted) return;

    final amount = double.tryParse(amountCtrl.text.trim());
    if (amount == null || amount <= 0) return;

    final email = emailCtrl.text.trim().isNotEmpty
        ? emailCtrl.text.trim()
        : 'driver@keke.app';

    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);

    final url = await ref
        .read(driverFinanceControllerProvider.notifier)
        .topupWallet(amount, email);
    if (!mounted || url == null) return;

    final success = await navigator.push<bool>(
      MaterialPageRoute(builder: (_) => PaystackWebView(url: url)),
    );

    if (success == true && mounted) {
      await ref.read(driverFinanceControllerProvider.notifier).refresh();
      messenger.showSnackBar(
        SnackBar(
          backgroundColor: AppColors.success,
          content: Text('Top-up successful!',
              style: AppTextStyles.body(color: AppColors.white)),
        ),
      );
    }
  }

  Widget _buildDarkDialog({
    required BuildContext ctx,
    required String title,
    required Widget content,
    required String confirmLabel,
    Color? confirmColor,
    Color? confirmFgColor,
  }) {
    return AlertDialog(
      backgroundColor: AppColors.darkGray,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: Text(title, style: AppTextStyles.title(color: AppColors.white)),
      content: content,
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text('Cancel', style: AppTextStyles.body(color: AppColors.midGray)),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: confirmColor ?? AppColors.white,
            foregroundColor: confirmFgColor ?? AppColors.charcoal,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirmLabel, style: AppTextStyles.body(weight: FontWeight.w700)),
        ),
      ],
    );
  }
}

class _BalanceCard extends StatelessWidget {
  final String label;
  final double amount;
  final Color color;
  final IconData icon;

  const _BalanceCard({
    required this.label,
    required this.amount,
    required this.color,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withOpacity(0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: color.withOpacity(0.15),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: color, size: 18),
          ),
          const SizedBox(height: 12),
          Text(label, style: AppTextStyles.caption(color: AppColors.midGray)),
          const SizedBox(height: 4),
          Text(
            '₦${amount.toStringAsFixed(0)}',
            style: AppTextStyles.title(color: AppColors.white),
          ),
        ],
      ),
    );
  }
}

class _DarkField extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final TextInputType type;

  const _DarkField({
    required this.controller,
    required this.label,
    required this.type,
  });

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      keyboardType: type,
      style: AppTextStyles.body(color: AppColors.white),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: AppTextStyles.bodySmall(color: AppColors.midGray),
        enabledBorder: const UnderlineInputBorder(
          borderSide: BorderSide(color: AppColors.darkGray),
        ),
        focusedBorder: const UnderlineInputBorder(
          borderSide: BorderSide(color: AppColors.primary, width: 2),
        ),
      ),
    );
  }
}
