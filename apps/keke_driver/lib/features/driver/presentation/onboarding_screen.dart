import 'package:flutter/material.dart';
import 'dart:async';
import 'dart:io';
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
  final Map<String, String> _uploadedDocs = {};

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
    final profile = driverState.profile;
    
    // Strict completion check: All 3 URLs must exist in the backend-synced profile
    final bool allDocsUploaded = profile.licenseUrl != null && 
                               profile.idCardUrl != null && 
                               profile.vehiclePaperUrl != null;

    return Scaffold(
      appBar: AppBar(title: const Text('Driver Onboarding')),
      body: Stepper(
        currentStep: _currentStep,
        onStepContinue: () {
          if (_currentStep == 1 && !allDocsUploaded) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Please upload all 3 required documents to continue.'),
                backgroundColor: Colors.orange,
              ),
            );
            return;
          }
          _nextStep();
        },
        onStepCancel: () => setState(() => _currentStep--),
        controlsBuilder: (context, details) {
          final isStep2 = _currentStep == 1;
          final bool canContinue = !driverState.isLoading && (!isStep2 || allDocsUploaded);

          return Padding(
            padding: const EdgeInsets.only(top: 24.0),
            child: SizedBox(
              width: double.infinity,
              height: 50,
              child: ElevatedButton(
                onPressed: canContinue ? details.onStepContinue : null,
                style: ElevatedButton.styleFrom(
                  backgroundColor: canContinue ? Colors.amber : Colors.grey,
                  foregroundColor: Colors.black,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: Text(driverState.isLoading ? 'Processing...' : (allDocsUploaded && isStep2 ? 'Finalize & Submit' : 'Continue')),
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
    final profile = driverState.profile;
    
    // Check backend sync first
    String? backendUrl;
    if (type == 'license') backendUrl = profile.licenseUrl;
    else if (type == 'id_card') backendUrl = profile.idCardUrl;
    else if (type == 'vehicle_paper') backendUrl = profile.vehiclePaperUrl;

    final bool isUploaded = backendUrl != null;

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white10,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: isUploaded ? Colors.green.withOpacity(0.5) : Colors.white24),
      ),
      child: ListTile(
        leading: Icon(icon, color: isUploaded ? Colors.green : Colors.amber),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: isUploaded 
            ? const Text('✓ Document Verified', style: TextStyle(color: Colors.green)) 
            : const Text('Tap to capture', style: TextStyle(color: Colors.grey, fontSize: 12)),
        trailing: isUploaded 
          ? ActionChip(
              label: const Text('Retake', style: TextStyle(fontSize: 12, color: Colors.black)),
              backgroundColor: Colors.amber,
              onPressed: driverState.isLoading ? null : () => _pickAndUpload(type),
            )
          : const Icon(Icons.add_a_photo, color: Colors.amber),
        onTap: driverState.isLoading ? null : () => _pickAndUpload(type),
      ),
    );
  }

  Future<void> _pickAndUpload(String type) async {
    final picker = ImagePicker();
    final XFile? image = await picker.pickImage(
      source: ImageSource.camera, 
      imageQuality: 70,
      maxWidth: 1024,
      maxHeight: 1024,
    );
    
    if (image != null) {
      try {
        await ref.read(driverControllerProvider.notifier).uploadDocument(image.path, type);
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Upload failed: ${e.toString()}'), backgroundColor: Colors.red),
          );
        }
      }
    }
  }
}
