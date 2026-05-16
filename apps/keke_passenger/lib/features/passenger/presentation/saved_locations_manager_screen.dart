import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../../core/theme/app_theme.dart';
import '../data/passenger_repository.dart';
import '../domain/saved_location.dart';
import 'destination_search_screen.dart';

class SavedLocationsManagerScreen extends ConsumerStatefulWidget {
  const SavedLocationsManagerScreen({super.key});

  @override
  ConsumerState<SavedLocationsManagerScreen> createState() => _SavedLocationsManagerScreenState();
}

class _SavedLocationsManagerScreenState extends ConsumerState<SavedLocationsManagerScreen> {
  List<SavedLocation> _locations = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _fetchLocations();
  }

  Future<void> _fetchLocations() async {
    setState(() => _isLoading = true);
    try {
      final results = await ref.read(passengerRepositoryProvider).getSavedLocations();
      setState(() => _locations = results);
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Failed to load saved locations.')),
      );
    } finally {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _addLocation() async {
    if (_locations.length >= 5) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('You can only save up to 5 locations.')),
      );
      return;
    }

    final result = await Navigator.push<Map<String, dynamic>>(
      context,
      MaterialPageRoute(builder: (_) => const DestinationSearchScreen(hintText: 'Search for a place to save')),
    );

    if (result != null) {
      final nameController = TextEditingController();
      final name = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Name this location'),
          content: TextField(
            controller: nameController,
            decoration: const InputDecoration(hintText: 'e.g. Home, Office, School'),
            autofocus: true,
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
            TextButton(
              onPressed: () => Navigator.pop(context, nameController.text.trim()),
              child: const Text('Save'),
            ),
          ],
        ),
      );

      if (name != null && name.isNotEmpty) {
        setState(() => _isLoading = true);
        try {
          await ref.read(passengerRepositoryProvider).addSavedLocation(
            name: name,
            address: result['address'],
            lat: (result['location'] as LatLng).latitude,
            lng: (result['location'] as LatLng).longitude,
          );
          _fetchLocations();
        } catch (e) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Failed to save location.')),
          );
          setState(() => _isLoading = false);
        }
      }
    }
  }

  Future<void> _deleteLocation(String id) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Location'),
        content: const Text('Are you sure you want to delete this saved location?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      setState(() => _isLoading = true);
      try {
        await ref.read(passengerRepositoryProvider).deleteSavedLocation(id);
        _fetchLocations();
      } catch (e) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to delete location.')),
        );
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.white,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        elevation: 0,
        title: Text('Saved Locations', style: AppTextStyles.title(color: AppColors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator(color: AppColors.primary))
          : _locations.isEmpty
              ? _buildEmptyState()
              : _buildList(),
      floatingActionButton: _locations.length < 5
          ? FloatingActionButton.extended(
              onPressed: _addLocation,
              backgroundColor: AppColors.primary,
              icon: const Icon(Icons.add, color: AppColors.charcoal),
              label: Text('Add New', style: AppTextStyles.body(color: AppColors.charcoal, weight: FontWeight.w700)),
            )
          : null,
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.star_outline, size: 64, color: AppColors.border),
            const SizedBox(height: 24),
            Text('No saved locations yet', style: AppTextStyles.title(color: AppColors.charcoal)),
            const SizedBox(height: 12),
            Text(
              'Save your home, office, or other frequent places for faster booking.',
              textAlign: TextAlign.center,
              style: AppTextStyles.body(color: AppColors.midGray),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList() {
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _locations.length,
      separatorBuilder: (_, __) => const Divider(height: 24, color: AppColors.border),
      itemBuilder: (context, index) {
        final loc = _locations[index];
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.star, color: AppColors.primary, size: 24),
          ),
          title: Text(loc.name, style: AppTextStyles.body(color: AppColors.charcoal, weight: FontWeight.w700)),
          subtitle: Text(
            loc.address,
            style: AppTextStyles.bodySmall(color: AppColors.midGray),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: IconButton(
            icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
            onPressed: () => _deleteLocation(loc.id),
          ),
        );
      },
    );
  }
}
