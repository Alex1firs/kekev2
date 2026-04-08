import 'package:flutter/material.dart';
import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';

class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final _plateController = TextEditingController();
  final _modelController = TextEditingController();
  int _currentStep = 0;

  @override
  void dispose() {
    _plateController.dispose();
    _modelController.dispose();
    super.dispose();
  }

  void _nextStep() {
    if (_currentStep < 1) {
      setState(() => _currentStep++);
    } else {
      _finishOnboarding();
    }
  }

  void _finishOnboarding() {
    ref.read(driverControllerProvider.notifier).submitOnboarding(
      plate: _plateController.text,
      model: _modelController.text,
    );
  }

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverControllerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Driver Onboarding')),
      body: Stepper(
        currentStep: _currentStep,
        onStepContinue: _nextStep,
        onStepCancel: () => setState(() => _currentStep--),
        controlsBuilder: (context, details) {
          return Padding(
            padding: const EdgeInsets.only(top: 24.0),
            child: SizedBox(
              width: double.infinity,
              height: 50,
              child: ElevatedButton(
                onPressed: driverState.isLoading ? null : details.onStepContinue,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.amber,
                  foregroundColor: Colors.black,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: Text(driverState.isLoading ? 'Processing...' : 'Continue'),
              ),
            ),
          );
        },
        steps: [
          Step(
            title: const Text('Vehicle Info'),
            isActive: _currentStep >= 0,
            content: Column(
              children: [
                TextField(
                  controller: _plateController,
                  decoration: const InputDecoration(labelText: 'Keke License Plate (e.g. ANK-123)'),
                ),
                TextField(
                  controller: _modelController,
                  decoration: const InputDecoration(labelText: 'Vehicle Model (e.g. TVS King)'),
                ),
              ],
            ),
          ),
          Step(
            title: const Text('Documents Upload'),
            isActive: _currentStep >= 1,
            content: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8.0),
                  child: Text('Please upload clear photos of your documents for verification.', style: TextStyle(fontSize: 14)),
                ),
                _buildDocTile('Driver\'s License', Icons.badge_outlined, 'license'),
                _buildDocTile('Vehicle Papers', Icons.description_outlined, 'vehicle_paper'),
                _buildDocTile('NIN ID Card', Icons.credit_card_outlined, 'id_card'),
                const SizedBox(height: 16),
                const Text(
                  'Your documents are stored securely and only accessible to authorized Keke reviewers.',
                  style: TextStyle(fontSize: 11, color: Colors.grey),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDocTile(String title, IconData icon, String type) {
    final driverState = ref.watch(driverControllerProvider);
    // Simple state-based indicator: in this phase we'd ideally have a more granular check,
    // but for now we look at general status.
    final bool isUploaded = driverState.profile.status == DriverStatus.pendingReview;

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white10,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white24),
      ),
      child: ListTile(
        leading: Icon(icon, color: Colors.amber),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: isUploaded ? const Text('✓ Document Ready', style: TextStyle(color: Colors.green)) : null,
        trailing: isUploaded 
          ? const Icon(Icons.check_circle, color: Colors.green)
          : const Icon(Icons.add_a_photo, color: Colors.amber),
        onTap: isUploaded || driverState.isLoading ? null : () => _pickAndUpload(type),
      ),
    );
  }

  Future<void> _pickAndUpload(String type) async {
    final picker = ImagePicker();
    final XFile? image = await picker.pickImage(source: ImageSource.camera, imageQuality: 70);
    
    if (image != null) {
      await ref.read(driverControllerProvider.notifier).uploadDocument(image.path, type);
    }
  }
}
