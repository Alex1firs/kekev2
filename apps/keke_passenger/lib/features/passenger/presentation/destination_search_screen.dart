import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/theme/app_theme.dart';
import '../data/map_repository.dart';
import '../data/passenger_repository.dart';
import '../domain/saved_location.dart';

class DestinationSearchScreen extends ConsumerStatefulWidget {
  final String hintText;
  const DestinationSearchScreen({super.key, this.hintText = 'Where to?'});

  @override
  ConsumerState<DestinationSearchScreen> createState() =>
      _DestinationSearchScreenState();
}

class _DestinationSearchScreenState
    extends ConsumerState<DestinationSearchScreen> {
  final TextEditingController _searchCtrl = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  List<Map<String, dynamic>> _predictions = [];
  List<SavedLocation> _savedLocations = [];
  Timer? _debounce;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focusNode.requestFocus();
      _fetchSavedLocations();
    });
  }

  Future<void> _fetchSavedLocations() async {
    try {
      final results =
          await ref.read(passengerRepositoryProvider).getSavedLocations();
      if (mounted) setState(() => _savedLocations = results);
    } catch (_) {}
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
    final latLng = await ref.read(mapRepositoryProvider).getPlaceDetails(placeId);
    setState(() => _isLoading = false);
    if (latLng != null && mounted) {
      Navigator.pop(context, {'location': latLng, 'address': description});
    }
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
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
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
        title: TextField(
          controller: _searchCtrl,
          focusNode: _focusNode,
          style: AppTextStyles.body(color: AppColors.white),
          decoration: InputDecoration(
            hintText: widget.hintText,
            hintStyle: AppTextStyles.body(color: AppColors.midGray),
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
            focusedBorder: InputBorder.none,
            filled: false,
            suffixIcon: _searchCtrl.text.isNotEmpty
                ? IconButton(
                    icon: const Icon(Icons.close_rounded,
                        color: AppColors.midGray, size: 18),
                    onPressed: () {
                      _searchCtrl.clear();
                      setState(() => _predictions = []);
                    },
                  )
                : null,
          ),
          onChanged: (v) {
            setState(() {});
            _onSearchChanged(v);
          },
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(50),
          child: Column(
            children: [
              _buildSetOnMapButton(),
              AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                height: _isLoading ? 3 : 0,
                child: _isLoading
                    ? const LinearProgressIndicator(
                        color: AppColors.primary,
                        backgroundColor: AppColors.darkGray,
                        minHeight: 3,
                      )
                    : const SizedBox.shrink(),
              ),
            ],
          ),
        ),
      ),
      body: _predictions.isEmpty ? _buildEmptyState() : _buildResultsList(),
    );
  }

  Widget _buildSetOnMapButton() {
    return InkWell(
      onTap: () => Navigator.pop(context, {'manual_selection': true}),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
        decoration: const BoxDecoration(
          color: AppColors.charcoal,
          border: Border(top: BorderSide(color: Color(0xFF2A2A3A), width: 0.5)),
        ),
        child: Row(
          children: [
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(
                color: AppColors.primary.withOpacity(0.15),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(Icons.map_outlined,
                  color: AppColors.primary, size: 17),
            ),
            const SizedBox(width: 14),
            Text(
              'Set location on map',
              style: AppTextStyles.body(
                  color: AppColors.primary, weight: FontWeight.w600),
            ),
            const Spacer(),
            const Icon(Icons.chevron_right_rounded,
                color: AppColors.midGray, size: 18),
          ],
        ),
      ),
    );
  }

  Widget _buildResultsList() {
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _predictions.length,
      separatorBuilder: (_, __) =>
          const Divider(height: 1, indent: 66, color: AppColors.border),
      itemBuilder: (context, index) {
        final p = _predictions[index];
        final description = p['description'] as String;
        final parts = description.split(',');
        final primary = parts.first.trim();
        final secondary =
            parts.length > 1 ? parts.skip(1).join(',').trim() : '';

        return ListTile(
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
          leading: Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.location_on_outlined,
                color: AppColors.midGray, size: 20),
          ),
          title: Text(primary,
              style: AppTextStyles.body(
                  color: AppColors.charcoal, weight: FontWeight.w600)),
          subtitle: secondary.isNotEmpty
              ? Text(secondary,
                  style: AppTextStyles.bodySmall(color: AppColors.midGray),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis)
              : null,
          onTap: () => _handleSelection(p),
        );
      },
    );
  }

  Widget _buildEmptyState() {
    if (_searchCtrl.text.isEmpty) {
      return CustomScrollView(
        slivers: [
          // Saved locations
          if (_savedLocations.isNotEmpty) ...[
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 10),
                child: Row(
                  children: [
                    const Icon(Icons.star_rounded,
                        size: 16, color: AppColors.primary),
                    const SizedBox(width: 8),
                    Text('Saved Places',
                        style: AppTextStyles.label(
                            color: AppColors.midGray, weight: FontWeight.w700)),
                  ],
                ),
              ),
            ),
            SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, i) {
                  final loc = _savedLocations[i];
                  return ListTile(
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
                    leading: Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: AppColors.primary.withOpacity(0.1),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.star_rounded,
                          color: AppColors.primary, size: 20),
                    ),
                    title: Text(loc.name,
                        style: AppTextStyles.body(
                            color: AppColors.charcoal,
                            weight: FontWeight.w600)),
                    subtitle: Text(loc.address,
                        style: AppTextStyles.bodySmall(color: AppColors.midGray),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                    onTap: () => Navigator.pop(context,
                        {'location': loc.location, 'address': loc.address}),
                  );
                },
                childCount: _savedLocations.length,
              ),
            ),
            const SliverToBoxAdapter(
              child: Divider(color: AppColors.border, height: 24),
            ),
          ],

          // Prompt
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: AppColors.paleGray,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.search_rounded,
                        size: 30, color: AppColors.border),
                  ),
                  const SizedBox(height: 16),
                  Text('Where are you going?',
                      style: AppTextStyles.body(color: AppColors.midGray)),
                  const SizedBox(height: 6),
                  Text('Type a street, landmark, or area',
                      style:
                          AppTextStyles.bodySmall(color: AppColors.lightGray)),
                ],
              ),
            ),
          ),
        ],
      );
    }

    // No results found
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.location_off_outlined,
                size: 30, color: AppColors.border),
          ),
          const SizedBox(height: 16),
          Text('No results found',
              style: AppTextStyles.body(color: AppColors.midGray)),
          const SizedBox(height: 6),
          Text('Try a different search term',
              style: AppTextStyles.bodySmall(color: AppColors.lightGray)),
        ],
      ),
    );
  }
}
