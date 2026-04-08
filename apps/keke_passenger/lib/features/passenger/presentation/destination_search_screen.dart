import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../data/map_repository.dart';

class DestinationSearchScreen extends ConsumerStatefulWidget {
  const DestinationSearchScreen({super.key});

  @override
  ConsumerState<DestinationSearchScreen> createState() => _DestinationSearchScreenState();
}

class _DestinationSearchScreenState extends ConsumerState<DestinationSearchScreen> {
  final TextEditingController _searchController = TextEditingController();
  List<Map<String, dynamic>> _predictions = [];
  Timer? _debounce;
  bool _isLoading = false;

  void _onSearchChanged(String query) {
    if (_debounce?.isActive ?? false) _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 500), () async {
      if (query.isEmpty) {
        setState(() => _predictions = []);
        return;
      }

      setState(() => _isLoading = true);
      final results = await ref.read(mapRepositoryProvider).getAutocompletePredictions(query);
      setState(() {
        _predictions = results;
        _isLoading = false;
      });
    });
  }

  Future<void> _handleSelection(Map<String, dynamic> prediction) async {
    final placeId = prediction['place_id'];
    final description = prediction['description'];
    
    setState(() => _isLoading = true);
    final latLng = await ref.read(mapRepositoryProvider).getPlaceDetails(placeId);
    setState(() => _isLoading = false);

    if (latLng != null && mounted) {
      Navigator.pop(context, {'location': latLng, 'address': description});
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _searchController,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'Where to?',
            border: InputBorder.none,
          ),
          onChanged: _onSearchChanged,
        ),
      ),
      body: Column(
        children: [
          if (_isLoading) const LinearProgressIndicator(),
          Expanded(
            child: ListView.builder(
              itemCount: _predictions.length,
              itemBuilder: (context, index) {
                final prediction = _predictions[index];
                return ListTile(
                  leading: const Icon(Icons.location_on_outlined),
                  title: Text(prediction['description']),
                  onTap: () => _handleSelection(prediction),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
