import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../auth/application/auth_controller.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';

class StatusInfoScreen extends ConsumerWidget {
  const StatusInfoScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final driverState = ref.watch(driverControllerProvider);
    final status = driverState.profile.status;

    return Scaffold(
      backgroundColor: Colors.black, // High contrast for outdoor
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 48.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              _buildIcon(status),
              const SizedBox(height: 32),
              _buildText(status),
              const SizedBox(height: 48),
              _buildAction(context, ref, status),
              const Spacer(),
              TextButton(
                onPressed: () {
                  ref.read(authControllerProvider.notifier).logout();
                },
                child: const Text('Log Out', style: TextStyle(color: Colors.grey)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildIcon(DriverStatus status) {
    switch (status) {
      case DriverStatus.pendingApproval:
        return const Icon(Icons.timer_outlined, size: 80, color: Colors.amber);
      case DriverStatus.suspended:
        return const Icon(Icons.block, size: 80, color: Colors.redAccent);
      case DriverStatus.rejected:
        return const Icon(Icons.warning_amber, size: 80, color: Colors.orange);
      default:
        return const Icon(Icons.help_outline, size: 80, color: Colors.grey);
    }
  }

  Widget _buildText(DriverStatus status) {
    String title = '';
    String subtitle = '';

    switch (status) {
      case DriverStatus.pendingApproval:
        title = 'Approval Pending';
        subtitle = 'Your documents are being verified by the Anambra State Keke Union. Check back in 24 hours.';
        break;
      case DriverStatus.suspended:
        title = 'Account Suspended';
        subtitle = 'Your account has been suspended due to policy violations. Contact support for assistance.';
        break;
      case DriverStatus.rejected:
        title = 'Verification Rejected';
        subtitle = 'Your documents were not clear enough. Please resubmit your Driver\'s License.';
        break;
      default:
        title = 'Unknown Status';
        subtitle = 'Please wait while we resolve your account state.';
    }

    return Column(
      children: [
        Text(title, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: Colors.white)),
        const SizedBox(height: 16),
        Text(subtitle, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, color: Colors.grey)),
      ],
    );
  }

  Widget _buildAction(BuildContext context, WidgetRef ref, DriverStatus status) {
    if (status == DriverStatus.rejected) {
      return ElevatedButton(
        onPressed: () => context.push('/onboarding'),
        style: ElevatedButton.styleFrom(
          backgroundColor: Colors.amber,
          foregroundColor: Colors.black,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
        child: const Text('Resubmit Documents'),
      );
    }
    
    return const SizedBox.shrink();
  }
}
