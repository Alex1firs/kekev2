import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../application/driver_finance_controller.dart';
import '../domain/driver_finance_state.dart';

class EarningsScreen extends ConsumerWidget {
  const EarningsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final financeState = ref.watch(driverFinanceControllerProvider);

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('Earnings & Finance', style: TextStyle(color: Colors.white)),
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(driverFinanceControllerProvider.notifier).refresh(),
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _buildDebtAlert(financeState)),
            SliverToBoxAdapter(child: _buildBalanceSummary(financeState)),
            const SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20, 32, 20, 16),
                child: Text('Recent Transactions', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
              ),
            ),
            _buildHistoryList(financeState),
          ],
        ),
      ),
    );
  }

  Widget _buildDebtAlert(DriverFinanceState state) {
    if (state.commissionDebt <= 0) return const SizedBox.shrink();

    Color color = Colors.amber;
    String title = 'Commission Debt';
    String message = '₦${state.commissionDebt.toStringAsFixed(0)} owed to platform';

    if (state.commissionDebt >= 5000) {
      color = Colors.redAccent;
      title = 'HARD BLOCK';
      message = 'Debt exceeds ₦5,000. Account disabled.';
    } else if (state.commissionDebt >= 2000) {
      color = Colors.orangeAccent;
      title = 'Restriction Warning';
      message = 'Pay debt soon to avoid account block.';
    }

    return Container(
      margin: const EdgeInsets.all(20),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color, width: 2),
      ),
      child: Row(
        children: [
          Icon(Icons.warning_amber_rounded, color: color, size: 32),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 16)),
                Text(message, style: TextStyle(color: color.withOpacity(0.8))),
              ],
            ),
          ),
          TextButton(
            onPressed: () {},
            child: Text('PAY NOW', style: TextStyle(color: color, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  Widget _buildBalanceSummary(DriverFinanceState state) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Column(
        children: [
          _buildSummaryItem('Available for Payout', state.availableBalance, Colors.greenAccent),
          const SizedBox(height: 12),
          _buildSummaryItem('Pending (Processing)', state.pendingBalance, Colors.white60),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              onPressed: state.availableBalance > 0 ? () {} : null,
              child: const Text('INITIATE PAYOUT', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSummaryItem(String label, double amount, Color color) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: const TextStyle(color: Colors.white70, fontSize: 16)),
        Text(
          '₦${amount.toStringAsFixed(2)}',
          style: TextStyle(color: color, fontSize: 20, fontWeight: FontWeight.bold),
        ),
      ],
    );
  }

  Widget _buildHistoryList(DriverFinanceState state) {
    if (state.isLoading && state.history.isEmpty) {
      return const SliverFillRemaining(child: Center(child: CircularProgressIndicator(color: Colors.amber)));
    }

    return SliverList(
      delegate: SliverChildBuilderDelegate(
        (context, index) {
          final entry = state.history[index];
          final isCredit = entry.amount > 0;

          return ListTile(
            leading: Icon(
              isCredit ? Icons.arrow_downward : Icons.arrow_upward,
              color: isCredit ? Colors.greenAccent : Colors.redAccent,
            ),
            title: Text(entry.description, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w500)),
            subtitle: Text(entry.id, style: const TextStyle(color: Colors.white38, fontSize: 12)),
            trailing: Text(
              '${isCredit ? "+" : ""}₦${entry.amount.abs().toStringAsFixed(0)}',
              style: TextStyle(
                color: isCredit ? Colors.greenAccent : Colors.redAccent,
                fontWeight: FontWeight.bold,
                fontSize: 16,
              ),
            ),
          );
        },
        childCount: state.history.length,
      ),
    );
  }
}
