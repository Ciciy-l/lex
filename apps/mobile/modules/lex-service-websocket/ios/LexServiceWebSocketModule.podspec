Pod::Spec.new do |s|
  s.name = 'LexServiceWebSocketModule'
  s.version = '0.1.0'
  s.summary = 'Origin-bound WebSocket transport for Lex Server.'
  s.license = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author = 'Lex'
  s.homepage = 'https://github.com/Ciciy-l/lex'
  s.source = { :git => 'https://github.com/Ciciy-l/lex.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '*.swift'
  s.dependency 'ExpoModulesCore'
end
