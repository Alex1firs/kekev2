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
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(driverFinanceControllerProvider.notifier).refresh();
    });
  }

  @override
  Widget build(BuildContext context) {
    final financeState = ref.watch(driverFinanceControllerProvider);

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        foregroundColor: AppColors.white,
        elevation: 0,
        title: Text('Earnings & Finance',
            style: AppTextStyles.title(color: AppColors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
        actions: [
          if (financeState.isLoading)
            const Padding(
              padding: EdgeInsets.only(right: 16),
              child: Center(
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: AppColors.primary),
                ),
              ),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () =>
            ref.read(driverFinanceControllerProvider.notifier).refresh(),
        color: AppColors.primary,
        backgroundColor: AppColors.darkGray,
        child: CustomScrollView(
          slivers: [
            if (financeState.commissionDebt >= 1000)
              SliverToBoxAdapter(child: _buildDebtAlert(financeState)),
            SliverToBoxAdapter(child: _buildHeroCard(financeState)),
            SliverToBoxAdapter(child: _buildPendingRow(financeState)),
            SliverToBoxAdapter(child: _buildActionRow(financeState)),
            SliverToBoxAdapter(child: _buildHistoryHeader()),
            _buildHistoryList(financeState),
            const SliverToBoxAdapter(child: SizedBox(height: 40)),
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
      message =
          'Debt ₦${state.commissionDebt.toStringAsFixed(0)} exceeds limit. Clear to go online.';
    } else if (state.commissionDebt >= 2000) {
      borderColor = const Color(0xFFEA580C);
      bgColor = const Color(0xFF3B1A0A);
      fgColor = const Color(0xFFFBBF24);
      title = 'Cash Rides Blocked';
      message =
          '₦${state.commissionDebt.toStringAsFixed(0)} debt — wallet rides still available.';
    } else {
      borderColor = AppColors.primary;
      bgColor = const Color(0xFF3B2A00);
      fgColor = AppColors.primary;
      title = 'Debt Warning';
      message = '₦${state.commissionDebt.toStringAsFixed(0)} owed to platform.';
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
                Text(title,
                    style: AppTextStyles.body(
                        color: fgColor, weight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(message,
                    style:
                        AppTextStyles.bodySmall(color: fgColor.withOpacity(0.8))),
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
              child: Text('Pay Now',
                  style: AppTextStyles.bodySmall(
                      color: fgColor, weight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHeroCard(DriverFinanceState state) {
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 24, 20, 0),
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.success.withOpacity(0.3)),
        boxShadow: const [
          BoxShadow(
              color: Color(0x30000000), blurRadius: 16, offset: Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: AppColors.success.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(Icons.account_balance_wallet_outlined,
                    color: AppColors.success, size: 20),
              ),
              const SizedBox(width: 12),
              Text('Available Balance',
                  style: AppTextStyles.body(color: AppColors.midGray)),
              const Spacer(),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            '₦${state.availableBalance.toStringAsFixed(2)}',
            style: AppTextStyles.display(
                color: AppColors.success, weight: FontWeight.w800),
          ),
          const SizedBox(height: 20),
          // Action buttons
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.white,
                    foregroundColor: AppColors.charcoal,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                    elevation: 0,
                  ),
                  onPressed: state.availableBalance > 0
                      ? () => _showPayoutDialog(state)
                      : null,
                  icon: const Icon(Icons.arrow_upward_rounded, size: 18),
                  label: Text('Payout',
                      style: AppTextStyles.body(weight: FontWeight.w700)),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: AppColors.charcoal,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                    elevation: 0,
                  ),
                  onPressed: () => _showTopUpDialog(),
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: Text('Top Up',
                      style: AppTextStyles.body(weight: FontWeight.w700)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPendingRow(DriverFinanceState state) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: _StatTile(
                  label: 'Pending',
                  displayValue: '₦${state.pendingBalance.toStringAsFixed(0)}',
                  icon: Icons.hourglass_top_rounded,
                  color: AppColors.lightGray,
                ),
              ),
              if (state.commissionDebt > 0) ...[
                const SizedBox(width: 12),
                Expanded(
                  child: _StatTile(
                    label: 'Commission Debt',
                    displayValue: '₦${state.commissionDebt.toStringAsFixed(0)}',
                    icon: Icons.warning_amber_rounded,
                    color: AppColors.error,
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _StatTile(
                  label: 'Total Trips',
                  displayValue: '${state.totalTrips}',
                  icon: Icons.local_taxi_rounded,
                  color: AppColors.primary,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _StatTile(
                  label: 'Commission Paid',
                  displayValue: '₦${state.totalCommissionPaid.toStringAsFixed(0)}',
                  icon: Icons.check_circle_outline_rounded,
                  color: AppColors.success,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildActionRow(DriverFinanceState state) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      child: OutlinedButton.icon(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.lightGray,
          side: const BorderSide(color: AppColors.darkGray),
          padding: const EdgeInsets.symmetric(vertical: 14),
          minimumSize: const Size(double.infinity, 50),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
        onPressed: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => const DriverTripHistoryScreen())),
        icon: const Icon(Icons.history_rounded, size: 18),
        label: Text('Trip History',
            style: AppTextStyles.body(color: AppColors.lightGray)),
      ),
    );
  }

  Widget _buildHistoryHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 28, 20, 12),
      child: Row(
        children: [
          Text('Recent Transactions',
              style: AppTextStyles.title(color: AppColors.white)),
          const Spacer(),
          Text('Pull to refresh',
              style: AppTextStyles.caption(color: AppColors.midGray)),
        ],
      ),
    );
  }

  Widget _buildHistoryList(DriverFinanceState state) {
    if (state.isLoading && state.history.isEmpty) {
      return const SliverFillRemaining(
        child: Center(
            child: CircularProgressIndicator(color: AppColors.primary)),
      );
    }

    if (state.history.isEmpty) {
      return SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.only(top: 48),
          child: Column(
            children: [
              const Icon(Icons.receipt_long_outlined,
                  color: AppColors.darkGray, size: 52),
              const SizedBox(height: 12),
              Text('No transactions yet',
                  style: AppTextStyles.body(color: AppColors.midGray)),
              const SizedBox(height: 4),
              Text('Start driving to earn',
                  style: AppTextStyles.bodySmall(color: AppColors.midGray)),
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

          return GestureDetector(
            onTap: () => _showReceiptDialog(context, entry),
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: AppColors.darkGray,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: isCredit
                        ? AppColors.success.withOpacity(0.15)
                        : AppColors.error.withOpacity(0.15),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    isCredit
                        ? Icons.arrow_downward_rounded
                        : Icons.arrow_upward_rounded,
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
    final accountNumCtrl = TextEditingController();
    final amountCtrl =
        TextEditingController(text: state.availableBalance.toStringAsFixed(0));
    String? selectedBank;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => _buildDarkDialog(
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
              _DarkField(
                  controller: amountCtrl,
                  label: 'Amount (₦)',
                  type: TextInputType.number),
              const SizedBox(height: 12),
              // Bank picker
              GestureDetector(
                onTap: () async {
                  final bank = await _showBankPicker(ctx);
                  if (bank != null) setDialogState(() => selectedBank = bank);
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  decoration: const BoxDecoration(
                    border: Border(
                      bottom: BorderSide(color: AppColors.midGray, width: 1),
                    ),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          selectedBank ?? 'Select Bank',
                          style: AppTextStyles.body(
                            color: selectedBank != null
                                ? AppColors.white
                                : AppColors.midGray,
                          ),
                        ),
                      ),
                      const Icon(Icons.arrow_drop_down,
                          color: AppColors.midGray),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              _DarkField(
                  controller: accountNumCtrl,
                  label: 'Account Number',
                  type: TextInputType.number),
              const SizedBox(height: 10),
              Text(
                'Requests are reviewed by the platform team before transfer.',
                style: AppTextStyles.caption(color: AppColors.midGray),
              ),
            ],
          ),
          confirmLabel: 'Submit Request',
        ),
      ),
    );

    if (confirmed != true || !mounted) return;

    final amount = double.tryParse(amountCtrl.text.trim()) ?? 0;
    final accountNum = accountNumCtrl.text.trim();

    if (amount <= 0 || selectedBank == null || accountNum.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('All fields are required')),
      );
      return;
    }

    final success = await ref
        .read(driverFinanceControllerProvider.notifier)
        .initiatePayout(amount, selectedBank!, accountNum);

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

  Future<String?> _showBankPicker(BuildContext ctx) async {
    final searchCtrl = TextEditingController();
    List<String> filtered = _kNigerianBanks;

    return showDialog<String>(
      context: ctx,
      builder: (pickerCtx) => StatefulBuilder(
        builder: (pickerCtx, setPickerState) => Dialog(
          backgroundColor: AppColors.darkGray,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Select Bank',
                    style: AppTextStyles.title(color: AppColors.white)),
                const SizedBox(height: 12),
                TextField(
                  controller: searchCtrl,
                  autofocus: true,
                  style: AppTextStyles.body(color: AppColors.white),
                  decoration: InputDecoration(
                    hintText: 'Search bank...',
                    hintStyle:
                        AppTextStyles.body(color: AppColors.midGray),
                    prefixIcon: const Icon(Icons.search,
                        color: AppColors.midGray, size: 20),
                    filled: true,
                    fillColor: AppColors.charcoal,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 10),
                  ),
                  onChanged: (q) {
                    setPickerState(() {
                      filtered = _kNigerianBanks
                          .where((b) =>
                              b.toLowerCase().contains(q.toLowerCase()))
                          .toList();
                    });
                  },
                ),
                const SizedBox(height: 8),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 320),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: filtered.length,
                    itemBuilder: (_, i) => ListTile(
                      title: Text(filtered[i],
                          style: AppTextStyles.body(color: AppColors.white)),
                      onTap: () => Navigator.pop(pickerCtx, filtered[i]),
                      dense: true,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8)),
                      hoverColor: AppColors.primary.withOpacity(0.08),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _handlePayNow(DriverFinanceState state) async {
    final controller = ref.read(driverFinanceControllerProvider.notifier);

    if (state.availableBalance > 0 && state.commissionDebt > 0) {
      final applied = await controller.repayDebt();
      if (!mounted) return;

      final remaining =
          ref.read(driverFinanceControllerProvider).commissionDebt;
      if (remaining <= 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            backgroundColor: AppColors.success,
            content: Text(
                '₦${applied.toStringAsFixed(0)} applied — debt cleared!',
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
        final email = decoded['email']?.toString();
        if (email != null) emailCtrl.text = email;
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
            _DarkField(
                controller: amountCtrl,
                label: 'Amount (₦)',
                type: TextInputType.number),
            const SizedBox(height: 12),
            _DarkField(
                controller: emailCtrl,
                label: 'Email (for receipt)',
                type: TextInputType.emailAddress),
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

    final topup = await ref
        .read(driverFinanceControllerProvider.notifier)
        .topupWallet(amount, email);
    if (!mounted || topup == null) return;

    final callbackRef = await navigator.push<String>(
      MaterialPageRoute(builder: (_) => PaystackWebView(url: topup['url']!)),
    );

    if (!mounted) return;
    final reference = callbackRef ?? topup['reference']!;
    final verified = await ref
        .read(driverFinanceControllerProvider.notifier)
        .verifyTopup(reference);

    if (verified && mounted) {
      final tempEntry = DriverHistoryEntry(
        id: reference,
        amount: amount,
        type: 'topup',
        description: 'Wallet Top-up',
        date: DateTime.now(),
        metadata: {'reference': reference},
      );
      _showReceiptDialog(context, tempEntry);
    } else {
      messenger.showSnackBar(
        SnackBar(
          backgroundColor: verified ? AppColors.success : AppColors.primary,
          content: Text(
            verified
                ? 'Top-up successful! Balance updated.'
                : 'Payment received — balance updating shortly.',
            style: AppTextStyles.body(
                color: verified ? AppColors.white : AppColors.charcoal),
          ),
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
      title: Text(title,
          style: AppTextStyles.title(color: AppColors.white)),
      content: content,
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text('Cancel',
              style: AppTextStyles.body(color: AppColors.midGray)),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: confirmColor ?? AppColors.white,
            foregroundColor: confirmFgColor ?? AppColors.charcoal,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12)),
          ),
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirmLabel,
              style: AppTextStyles.body(weight: FontWeight.w700)),
        ),
      ],
    );
  }

  void _showReceiptDialog(BuildContext context, DriverHistoryEntry tx) {
    final isCredit = tx.amount > 0;
    final formattedDate = "${tx.date.year}-${tx.date.month.toString().padLeft(2, '0')}-${tx.date.day.toString().padLeft(2, '0')} ${tx.date.hour.toString().padLeft(2, '0')}:${tx.date.minute.toString().padLeft(2, '0')}";
    final reference = tx.metadata?['reference'] ?? tx.metadata?['rideId'] ?? tx.id;
    final amountText = '${isCredit ? "+" : "-"}₦${tx.amount.abs().toStringAsFixed(2)}';

    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: AppColors.darkGray,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: isCredit ? AppColors.success.withOpacity(0.15) : AppColors.white.withOpacity(0.1),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  isCredit ? Icons.check_circle_rounded : Icons.receipt_long_rounded,
                  color: isCredit ? AppColors.success : AppColors.white,
                  size: 36,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Transaction Receipt',
                style: AppTextStyles.title(color: AppColors.white),
              ),
              const SizedBox(height: 4),
              Text(
                tx.description,
                style: AppTextStyles.bodySmall(color: AppColors.midGray),
              ),
              const SizedBox(height: 24),
              Container(
                height: 1,
                width: double.infinity,
                color: AppColors.charcoal,
              ),
              const SizedBox(height: 16),
              _buildReceiptRow('Status', 'Successful', valueColor: AppColors.success, isBoldValue: true),
              const SizedBox(height: 12),
              _buildReceiptRow('Date & Time', formattedDate),
              const SizedBox(height: 12),
              _buildReceiptRow('Reference', reference, isSelectable: true),
              const SizedBox(height: 12),
              _buildReceiptRow('Amount', amountText, valueColor: isCredit ? AppColors.success : AppColors.error, isBoldValue: true),
              const SizedBox(height: 16),
              Container(
                height: 1,
                width: double.infinity,
                color: AppColors.charcoal,
              ),
              const SizedBox(height: 20),
              Text(
                '⚡ Keke Ride',
                style: AppTextStyles.caption(color: AppColors.midGray, weight: FontWeight.w700),
              ),
              const SizedBox(height: 24),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.white,
                        side: const BorderSide(color: AppColors.charcoal),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                      onPressed: () {
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                          content: Text('Screenshot this card to save your receipt!'),
                          behavior: SnackBarBehavior.floating,
                        ));
                      },
                      child: Text('Save', style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.w600)),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        foregroundColor: AppColors.charcoal,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                      onPressed: () => Navigator.pop(ctx),
                      child: Text('Close', style: AppTextStyles.body(weight: FontWeight.w700)),
                    ),
                  ),
                ],
              )
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildReceiptRow(String label, String value, {Color? valueColor, bool isBoldValue = false, bool isSelectable = false}) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: AppTextStyles.bodySmall(color: AppColors.midGray),
        ),
        const Spacer(),
        Expanded(
          flex: 2,
          child: isSelectable 
            ? SelectableText(
                value,
                textAlign: TextAlign.right,
                style: AppTextStyles.bodySmall(
                  color: valueColor ?? AppColors.white,
                  weight: isBoldValue ? FontWeight.w700 : FontWeight.w500,
                ),
              )
            : Text(
                value,
                textAlign: TextAlign.right,
                style: AppTextStyles.bodySmall(
                  color: valueColor ?? AppColors.white,
                  weight: isBoldValue ? FontWeight.w700 : FontWeight.w500,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
        ),
      ],
    );
  }
}

// ─── Nigerian bank list ───────────────────────────────────────────────────────

const _kNigerianBanks = [
  'Access Bank',
  'Citibank Nigeria',
  'Ecobank Nigeria',
  'Fidelity Bank',
  'First Bank of Nigeria',
  'First City Monument Bank (FCMB)',
  'Globus Bank',
  'Guaranty Trust Bank (GTBank)',
  'Heritage Bank',
  'Keystone Bank',
  'Kuda Bank',
  'Moniepoint Microfinance Bank',
  'Opay',
  'Palmpay',
  'Polaris Bank',
  'Providus Bank',
  'Stanbic IBTC Bank',
  'Standard Chartered Bank',
  'Sterling Bank',
  'SunTrust Bank',
  'Titan Trust Bank',
  'Union Bank of Nigeria',
  'United Bank for Africa (UBA)',
  'Unity Bank',
  'VFD Microfinance Bank',
  'Wema Bank',
  'Zenith Bank',
];

// ─── Sub-widgets ─────────────────────────────────────────────────────────────

class _StatTile extends StatelessWidget {
  final String label;
  final String displayValue;
  final IconData icon;
  final Color color;

  const _StatTile({
    required this.label,
    required this.displayValue,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withOpacity(0.2)),
      ),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: color.withOpacity(0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: color, size: 17),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label,
                    style: AppTextStyles.caption(color: AppColors.midGray)),
                Text(
                  displayValue,
                  style: AppTextStyles.body(
                      color: AppColors.white, weight: FontWeight.w700),
                ),
              ],
            ),
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
