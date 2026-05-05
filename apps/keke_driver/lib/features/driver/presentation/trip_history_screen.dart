import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart' as dio;
import '../../../../core/theme/app_theme.dart';
import '../../../core/network/api_client.dart';

class RideHistoryEntry {
  final String rideId;
  final String status;
  final String paymentMode;
  final double fare;
  final String pickupAddress;
  final String destinationAddress;
  final DateTime createdAt;

  RideHistoryEntry({
    required this.rideId,
    required this.status,
    required this.paymentMode,
    required this.fare,
    required this.pickupAddress,
    required this.destinationAddress,
    required this.createdAt,
  });

  factory RideHistoryEntry.fromJson(Map<String, dynamic> json) {
    return RideHistoryEntry(
      rideId: json['rideId'] as String,
      status: json['status'] as String? ?? 'unknown',
      paymentMode: json['paymentMode'] as String? ?? 'cash',
      fare: double.parse(json['fare'].toString()),
      pickupAddress: json['pickupAddress'] as String? ?? '',
      destinationAddress: json['destinationAddress'] as String? ?? '',
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}

class DriverTripHistoryScreen extends ConsumerStatefulWidget {
  const DriverTripHistoryScreen({super.key});

  @override
  ConsumerState<DriverTripHistoryScreen> createState() =>
      _DriverTripHistoryScreenState();
}

class _DriverTripHistoryScreenState
    extends ConsumerState<DriverTripHistoryScreen> {
  List<RideHistoryEntry> _rides = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final response = await api.dio.get('/rides/history/driver');
      final data = response.data as List<dynamic>;
      setState(() {
        _rides = data
            .map((e) => RideHistoryEntry.fromJson(e as Map<String, dynamic>))
            .toList();
        _isLoading = false;
      });
    } on dio.DioException catch (e) {
      setState(() {
        _error = e.response?.data?['error']?.toString() ?? 'Failed to load history';
        _isLoading = false;
      });
    } catch (_) {
      setState(() {
        _error = 'Failed to load history';
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.charcoal,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        foregroundColor: AppColors.white,
        elevation: 0,
        title: Text('Trip History', style: AppTextStyles.title(color: AppColors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _loadHistory,
        color: AppColors.primary,
        backgroundColor: AppColors.darkGray,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.primary),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: AppColors.error, size: 48),
            const SizedBox(height: 12),
            Text(_error!, style: AppTextStyles.body(color: AppColors.lightGray)),
            const SizedBox(height: 16),
            TextButton(
              onPressed: _loadHistory,
              child: Text('Retry', style: AppTextStyles.body(color: AppColors.primary)),
            ),
          ],
        ),
      );
    }

    if (_rides.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.electric_rickshaw, color: AppColors.darkGray, size: 64),
            const SizedBox(height: 16),
            Text('No trips yet', style: AppTextStyles.title(color: AppColors.midGray)),
            const SizedBox(height: 6),
            Text(
              'Completed trips will appear here',
              style: AppTextStyles.body(color: AppColors.midGray),
            ),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      itemCount: _rides.length,
      itemBuilder: (context, index) {
        final ride = _rides[index];
        final isCash = ride.paymentMode == 'cash';
        final isCompleted = ride.status == 'completed';

        return Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.darkGray,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: isCompleted
                      ? AppColors.success.withOpacity(0.15)
                      : AppColors.error.withOpacity(0.1),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  isCompleted ? Icons.check_rounded : Icons.close_rounded,
                  color: isCompleted ? AppColors.success : AppColors.error,
                  size: 20,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            ride.pickupAddress.isNotEmpty
                                ? ride.pickupAddress
                                : 'Unknown pickup',
                            style: AppTextStyles.body(
                                color: AppColors.white, weight: FontWeight.w600),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 8),
                        _PaymentBadge(isCash: isCash),
                      ],
                    ),
                    if (ride.destinationAddress.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        '→ ${ride.destinationAddress}',
                        style: AppTextStyles.bodySmall(color: AppColors.midGray),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    const SizedBox(height: 8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          _formatDate(ride.createdAt),
                          style: AppTextStyles.caption(color: AppColors.midGray),
                        ),
                        Text(
                          '₦${ride.fare.toStringAsFixed(0)}',
                          style: AppTextStyles.body(
                            color: isCompleted ? AppColors.success : AppColors.midGray,
                            weight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
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
}

class _PaymentBadge extends StatelessWidget {
  final bool isCash;
  const _PaymentBadge({required this.isCash});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: isCash
            ? const Color(0xFF065F46)
            : AppColors.charcoal,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        isCash ? 'Cash' : 'Wallet',
        style: AppTextStyles.caption(
          color: isCash ? const Color(0xFF6EE7B7) : AppColors.lightGray,
          weight: FontWeight.w700,
        ),
      ),
    );
  }
}
