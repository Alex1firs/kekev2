import 'dart:io';

import 'package:dio/dio.dart';

/// Maps transport-level Dio failures to something a passenger can act on.
///
/// Without this, Dio's own text reaches the user verbatim — e.g. "The request
/// connection took longer than 0:00:15.000000 and it was aborted. To get rid of
/// this exception, try raising the RequestOptions.connectTimeout...", which is
/// meaningless to someone whose mobile data is simply weak.
///
/// Returns null when the failure carries a real server response (< 500), so
/// callers keep preferring the API's own error text.
String? networkErrorMessage(DioException e) {
  switch (e.type) {
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.sendTimeout:
    case DioExceptionType.receiveTimeout:
      return 'Network is too slow right now. Move to a spot with better signal and try again.';
    case DioExceptionType.connectionError:
      return 'No internet connection. Turn on mobile data or Wi-Fi and try again.';
    case DioExceptionType.badCertificate:
      return 'Could not open a secure connection. Check that your phone date and time are correct.';
    case DioExceptionType.badResponse:
      final status = e.response?.statusCode ?? 0;
      return status >= 500
          ? 'Server is temporarily unavailable. Please try again in a moment.'
          : null;
    case DioExceptionType.cancel:
      return null;
    case DioExceptionType.unknown:
      // A dropped socket usually lands here rather than in connectionError.
      return e.error is SocketException
          ? 'No internet connection. Turn on mobile data or Wi-Fi and try again.'
          : null;
  }
}
