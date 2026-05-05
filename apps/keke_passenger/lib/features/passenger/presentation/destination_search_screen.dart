import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/theme/app_theme.dart';
import '../data/map_repository.dart';

class DestinationSearchScreen extends ConsumerStatefulWidget {
  final String hintText;
  const DestinationSearchScreen({super.key, this.hintText = 'Where to?'});

  @override
  ConsumerState<DestinationSearchScreen> createState() =>
      _DestinationSearchScreenState();
}

class _DestinationSearchScreenState
    extends ConsumerState<DestinationSearchScreen> {
  final TextEditingController _searchController = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  List<Map<String, dynamic>> _predictions = [];
  Timer? _debounce;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focusNode.requestFocus());
  }

  void _onSearchChanged(String query) {
    if (_debounce?.isActive ?? false) _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 500), () async {
      if (query.isEmpty) {
        setState(() => _predictions = []);
        return;
      }

      setState(() => _isLoading = true);
      final results =
          await ref.read(mapRepositoryProvider).getAutocompletePredictions(query);
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
    final latLng =
        await ref.read(mapRepositoryProvider).getPlaceDetails(placeId);
    setState(() => _isLoading = false);

    if (latLng != null && mounted) {
      Navigator.pop(context, {'location': latLng, 'address': description});
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    _focusNode.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.white,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: TextField(
          controller: _searchController,
          focusNode: _focusNode,
          style: AppTextStyles.body(color: AppColors.white),
          decoration: InputDecoration(
            hintText: widget.hintText,
            hintStyle: AppTextStyles.body(color: AppColors.midGray),
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
            focusedBorder: InputBorder.none,
            suffixIcon: _searchController.text.isNotEmpty
                ? IconButton(
                    icon: const Icon(Icons.close, color: AppColors.midGray, size: 18),
                    onPressed: () {
                      _searchController.clear();
                      setState(() => _predictions = []);
                    },
                  )
                : null,
          ),
          onChanged: (v) {
            setState(() {}); // Refresh suffix icon
            _onSearchChanged(v);
          },
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(3),
          child: _isLoading
              ? const LinearProgressIndicator(
                  color: AppColors.primary,
                  backgroundColor: AppColors.darkGray,
                )
              : const SizedBox(height: 3),
        ),
      ),
      body: _predictions.isEmpty
          ? _buildEmptyState()
          : ListView.separated(
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: _predictions.length,
              separatorBuilder: (_, __) => const Divider(
                height: 1,
                indent: 60,
                color: AppColors.border,
              ),
              itemBuilder: (context, index) {
                final prediction = _predictions[index];
                final description = prediction['description'] as String;
                final parts = description.split(',');
                final primary = parts.first.trim();
                final secondary =
                    parts.length > 1 ? parts.skip(1).join(',').trim() : '';

                return ListTile(
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 8,
                  ),
                  leading: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: AppColors.paleGray,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.location_on_outlined,
                      color: AppColors.midGray,
                      size: 20,
                    ),
                  ),
                  title: Text(
                    primary,
                    style: AppTextStyles.body(
                        color: AppColors.charcoal, weight: FontWeight.w600),
                  ),
                  subtitle: secondary.isNotEmpty
                      ? Text(
                          secondary,
                          style: AppTextStyles.bodySmall(color: AppColors.midGray),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        )
                      : null,
                  onTap: () => _handleSelection(prediction),
                );
              },
            ),
    );
  }

  Widget _buildEmptyState() {
    if (_searchController.text.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.search_rounded, size: 56, color: AppColors.border),
            const SizedBox(height: 16),
            Text(
              'Search for your destination',
              style: AppTextStyles.body(color: AppColors.lightGray),
            ),
            const SizedBox(height: 6),
            Text(
              'Try a street, landmark, or area',
              style: AppTextStyles.bodySmall(color: AppColors.lightGray),
            ),
          ],
        ),
      );
    }

    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.location_off_outlined, size: 48, color: AppColors.border),
          const SizedBox(height: 16),
          Text(
            'No results found',
            style: AppTextStyles.body(color: AppColors.midGray),
          ),
          const SizedBox(height: 6),
          Text(
            'Try a different search term',
            style: AppTextStyles.bodySmall(color: AppColors.lightGray),
          ),
        ],
      ),
    );
  }
}
