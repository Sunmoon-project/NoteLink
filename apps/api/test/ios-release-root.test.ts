import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('저장소 iOS 프로젝트 Release 번들', () => {
  it('Expo Scene delegate를 등록하고 AppDelegate에서 윈도우를 중복 시작하지 않는다', () => {
    const plist = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))',
          resolve(root, 'ios/notelink/Info.plist'),
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(plist.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    });
    const delegate = readFileSync(resolve(root, 'ios/notelink/AppDelegate.swift'), 'utf8');
    expect(delegate).toContain('ExpoAppDelegate, ExpoReactNativeFactoryProvider');
    expect(delegate).not.toContain('UIWindow(frame:');
    expect(delegate).not.toContain('factory.startReactNative(');
    expect(delegate).toContain('reactNativeFactory = factory');
  });

  it('Pods의 Expo Constants 설정에 모바일 scheme이 포함된다', () => {
    const podfile = readFileSync(resolve(root, 'ios/Podfile'), 'utf8');
    expect(podfile).toContain("build_config.build_settings['PROJECT_ROOT'] = app_root");
    const destination = mkdtempSync(resolve(tmpdir(), 'notelink-constants-test-'));
    mkdirSync(resolve(destination, 'EXConstants.bundle'));
    try {
      execFileSync(
        '/bin/bash',
        [resolve(root, 'node_modules/expo-constants/scripts/get-app-config-ios.sh')],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            PROJECT_DIR: resolve(root, 'ios/Pods'),
            PODS_ROOT: resolve(root, 'ios/Pods'),
            PROJECT_ROOT: resolve(root, 'apps/mobile'),
            CONFIGURATION_BUILD_DIR: destination,
            BUNDLE_FORMAT: 'shallow',
          },
          stdio: 'pipe',
        },
      );
      const config = JSON.parse(
        readFileSync(resolve(destination, 'EXConstants.bundle/app.config'), 'utf8'),
      );
      expect(config.scheme).toBe('notelink');
      const plist = execFileSync(
        'python3',
        [
          '-c',
          'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))',
          resolve(root, 'ios/notelink/Info.plist'),
        ],
        { encoding: 'utf8' },
      );
      const schemes = JSON.parse(plist).CFBundleURLTypes.flatMap(
        (item: { CFBundleURLSchemes: string[] }) => item.CFBundleURLSchemes,
      );
      expect(schemes).toContain(config.scheme);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('Xcode 번들 단계가 실제 모바일 앱의 Expo Router 진입점을 해석한다', () => {
    const project = readFileSync(resolve(root, 'ios/notelink.xcodeproj/project.pbxproj'), 'utf8');
    const phase = project.slice(project.indexOf('name = "Bundle React Native code and images";'));
    const encoded = phase.match(/shellScript = ("(?:[^"\\]|\\.)*");/)![1]!;
    const script: string = JSON.parse(encoded);
    const setup = script.slice(0, script.lastIndexOf('`"$NODE_BINARY"'));
    const output = execFileSync(
      '/bin/bash',
      [
        '-e',
        '-c',
        setup +
          '\nprintf "\\nROOT=%s\\nENTRY=%s\\nCOMMAND=%s\\n" "$PROJECT_ROOT" "$ENTRY_FILE" "$BUNDLE_COMMAND"',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PROJECT_DIR: resolve(root, 'ios'),
          PODS_ROOT: '/nonexistent/notelink-test-pods',
          NODE_BINARY: process.execPath,
          CONFIGURATION: 'Release',
          ENTRY_FILE: '',
          CLI_PATH: '',
          BUNDLE_COMMAND: '',
        },
        encoding: 'utf8',
      },
    );
    const values = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    expect(resolve(values.ROOT!)).toBe(resolve(root, 'apps/mobile'));
    expect(values.ENTRY).toContain('/expo-router/entry');
    expect(values.COMMAND).toBe('export:embed');
  });
});
