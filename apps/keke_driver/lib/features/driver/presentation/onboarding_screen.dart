import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import '../../../../core/theme/app_theme.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';

class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();
  final _plateController = TextEditingController();
  final _modelController = TextEditingController();
  int _currentStep = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final profile = ref.read(driverControllerProvider).profile;
      _plateController.text = profile.vehiclePlate ?? '';
      _modelController.text = profile.vehicleModel ?? '';
    });
  }

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
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
      firstName: _firstNameController.text,
      lastName: _lastNameController.text,
      plate: _plateController.text,
      model: _modelController.text,
    );
  }

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverControllerProvider);
    final profile = driverState.profile;

    final bool allDocsUploaded = profile.licenseUrl != null &&
        profile.idCardUrl != null &&
        profile.vehiclePaperUrl != null;

    return Scaffold(
      backgroundColor: AppColors.snow,
      body: Column(
        children: [
          // Header
          Container(
            color: AppColors.charcoal,
            padding: EdgeInsets.fromLTRB(
              24,
              MediaQuery.of(context).padding.top + 16,
              24,
              28,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.2),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.electric_rickshaw,
                      color: AppColors.primary, size: 24),
                ),
                const SizedBox(height: 20),
                Text(
                  'Driver Onboarding',
                  style: AppTextStyles.headline(color: AppColors.white),
                ),
                const SizedBox(height: 6),
                Text(
                  'Complete your profile to start accepting rides',
                  style: AppTextStyles.body(color: AppColors.midGray),
                ),
                const SizedBox(height: 24),
                _StepProgress(current: _currentStep, total: 2),
              ],
            ),
          ),

          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: _currentStep == 0
                  ? _buildVehicleInfoStep(driverState)
                  : _buildDocumentsStep(profile, driverState, allDocsUploaded),
            ),
          ),

          // Bottom action
          Padding(
            padding: EdgeInsets.fromLTRB(
              24, 0, 24, MediaQuery.of(context).padding.bottom + 20),
            child: Column(
              children: [
                if (driverState.errorMessage != null) ...[
                  _ErrorBanner(message: driverState.errorMessage!),
                  const SizedBox(height: 12),
                ],
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: AppColors.charcoal,
                      padding: const EdgeInsets.symmetric(vertical: 18),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                      elevation: 0,
                    ),
                    onPressed: driverState.isLoading ||
                            (_currentStep == 1 && !allDocsUploaded)
                        ? null
                        : () {
                            if (_currentStep == 1 && !allDocsUploaded) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  backgroundColor: AppColors.primary,
                                  content: Text(
                                    'Please upload all 3 required documents.',
                                    style: AppTextStyles.body(color: AppColors.charcoal),
                                  ),
                                ),
                              );
                              return;
                            }
                            _nextStep();
                          },
                    child: driverState.isLoading
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              color: AppColors.charcoal,
                            ),
                          )
                        : Text(
                            _currentStep == 1 && allDocsUploaded
                                ? 'Submit for Review'
                                : 'Continue',
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
        ],
      ),
    );
  }

  Widget _buildVehicleInfoStep(dynamic driverState) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Your Details', style: AppTextStyles.title(color: AppColors.charcoal)),
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('First Name',
                      style: AppTextStyles.label(
                          color: AppColors.darkGray, weight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  TextFormField(
                    controller: _firstNameController,
                    decoration: const InputDecoration(hintText: 'e.g. Emeka'),
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Last Name',
                      style: AppTextStyles.label(
                          color: AppColors.darkGray, weight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  TextFormField(
                    controller: _lastNameController,
                    decoration: const InputDecoration(hintText: 'e.g. Okonkwo'),
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        Text('Keke Plate Number',
            style: AppTextStyles.label(
                color: AppColors.darkGray, weight: FontWeight.w600)),
        const SizedBox(height: 6),
        TextFormField(
          controller: _plateController,
          decoration: const InputDecoration(
            hintText: 'e.g. ANK-123KW',
            prefixIcon: Icon(Icons.electric_rickshaw),
          ),
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 20),
        Text('Vehicle Model',
            style: AppTextStyles.label(
                color: AppColors.darkGray, weight: FontWeight.w600)),
        const SizedBox(height: 6),
        TextFormField(
          controller: _modelController,
          decoration: const InputDecoration(
            hintText: 'e.g. TVS King Deluxe',
            prefixIcon: Icon(Icons.electric_rickshaw),
          ),
          textInputAction: TextInputAction.done,
        ),
      ],
    );
  }

  Widget _buildDocumentsStep(
      DriverProfile profile, dynamic driverState, bool allDone) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Upload Documents', style: AppTextStyles.title(color: AppColors.charcoal)),
        const SizedBox(height: 6),
        Text(
          'Upload clear photos. Documents are reviewed within 24 hours.',
          style: AppTextStyles.body(color: AppColors.midGray),
        ),
        const SizedBox(height: 24),
        _DocTile(
          title: "Driver's License",
          icon: Icons.badge_outlined,
          type: 'license',
          isUploaded: profile.licenseUrl != null,
          isLoading: driverState.isLoading,
          onUpload: _pickAndUpload,
        ),
        const SizedBox(height: 12),
        _DocTile(
          title: 'Vehicle Papers',
          icon: Icons.description_outlined,
          type: 'vehicle_paper',
          isUploaded: profile.vehiclePaperUrl != null,
          isLoading: driverState.isLoading,
          onUpload: _pickAndUpload,
        ),
        const SizedBox(height: 12),
        _DocTile(
          title: 'NIN / ID Card',
          icon: Icons.credit_card_outlined,
          type: 'id_card',
          isUploaded: profile.idCardUrl != null,
          isLoading: driverState.isLoading,
          onUpload: _pickAndUpload,
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.paleGray,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              const Icon(Icons.lock_outline, color: AppColors.midGray, size: 18),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Documents are stored securely and only accessible to authorised Keke reviewers.',
                  style: AppTextStyles.caption(color: AppColors.midGray),
                ),
              ),
            ],
          ),
        ),
      ],
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
        await ref
            .read(driverControllerProvider.notifier)
            .uploadDocument(image.path, type);
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Upload failed: ${e.toString()}'),
              backgroundColor: AppColors.error,
            ),
          );
        }
      }
    }
  }
}

class _StepProgress extends StatelessWidget {
  final int current;
  final int total;

  const _StepProgress({required this.current, required this.total});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: List.generate(total, (i) {
        final active = i <= current;
        return Expanded(
          child: Container(
            margin: EdgeInsets.only(right: i < total - 1 ? 6 : 0),
            height: 4,
            decoration: BoxDecoration(
              color: active ? AppColors.primary : AppColors.darkGray,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        );
      }),
    );
  }
}

class _DocTile extends StatelessWidget {
  final String title;
  final IconData icon;
  final String type;
  final bool isUploaded;
  final bool isLoading;
  final Future<void> Function(String) onUpload;

  const _DocTile({
    required this.title,
    required this.icon,
    required this.type,
    required this.isUploaded,
    required this.isLoading,
    required this.onUpload,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: isLoading ? null : () => onUpload(type),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isUploaded ? AppColors.success.withOpacity(0.4) : AppColors.border,
          ),
          boxShadow: const [
            BoxShadow(color: Color(0x08000000), blurRadius: 6, offset: Offset(0, 2)),
          ],
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: isUploaded
                    ? AppColors.success.withOpacity(0.12)
                    : AppColors.paleGray,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                icon,
                color: isUploaded ? AppColors.success : AppColors.midGray,
                size: 22,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: AppTextStyles.body(
                      color: AppColors.charcoal,
                      weight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    isUploaded ? 'Uploaded — tap to retake' : 'Tap to capture photo',
                    style: AppTextStyles.caption(
                      color: isUploaded ? AppColors.success : AppColors.midGray,
                    ),
                  ),
                ],
              ),
            ),
            if (isUploaded)
              const Icon(Icons.check_circle, color: AppColors.success, size: 22)
            else
              const Icon(Icons.add_a_photo_outlined, color: AppColors.primary, size: 22),
          ],
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.errorLight,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.error.withOpacity(0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: AppColors.error, size: 18),
          const SizedBox(width: 10),
          Expanded(
              child: Text(message,
                  style: AppTextStyles.bodySmall(color: AppColors.error))),
        ],
      ),
    );
  }
}
