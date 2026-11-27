#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

// Match Apple's modern macOS 26+ 14x14pt traffic light diameter inside the 32pt
// transparent overlay titlebar even when UIDesignRequiresCompatibility is active
// (where AppKit defaults to classic 12x12pt buttons inside a 28pt titlebar).
static const CGFloat kPiNTargetTrafficLightDiameter = 14.0;
static const CGFloat kPiNTrafficLightLeftMargin = 12.0;
static const CGFloat kPiNTrafficLightPitch = 22.0;
static const CGFloat kPiNTrafficLightCenterYFromTop = 16.0;

static char kPiNTrafficLightControllerKey;

@interface PiNTrafficLightController : NSObject
@property (nonatomic, weak) NSWindow *window;
@property (nonatomic, weak) NSView *observedTitlebarView;
@property (nonatomic, assign) BOOL hasOrigGeometry;
@property (nonatomic, assign) NSSize origBoundsSize;
@property (nonatomic, assign) NSRect origCloseFrame;
@property (nonatomic, assign) NSRect origMinFrame;
@property (nonatomic, assign) NSRect origZoomFrame;
@property (nonatomic, assign) CGFloat nativeVisualDiameter;
@property (nonatomic, assign) BOOL isApplying;
@property (nonatomic, strong) NSTrackingArea *customGroupTrackingArea;
@end

@implementation PiNTrafficLightController

- (instancetype)initWithWindow:(NSWindow *)window {
    self = [super init];
    if (self) {
        _window = window;
        [self registerObservers];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    _observedTitlebarView = nil;
}

- (void)registerObservers {
    NSWindow *window = self.window;
    if (window == nil) {
        return;
    }
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    NSArray<NSNotificationName> *layoutEvents = @[
        NSWindowDidResizeNotification,
        NSWindowDidEndLiveResizeNotification,
        NSWindowDidBecomeKeyNotification,
        NSWindowDidResignKeyNotification,
        NSWindowDidChangeBackingPropertiesNotification,
    ];
    for (NSNotificationName name in layoutEvents) {
        [nc addObserver:self selector:@selector(handleLayoutNotification:) name:name object:window];
    }
    [nc addObserver:self
           selector:@selector(handleWillEnterFullScreen:)
               name:NSWindowWillEnterFullScreenNotification
             object:window];
    [nc addObserver:self
           selector:@selector(handleDidExitFullScreen:)
               name:NSWindowDidExitFullScreenNotification
             object:window];
    [nc addObserver:self
           selector:@selector(handleWillClose:)
               name:NSWindowWillCloseNotification
             object:window];
    [self attachTitlebarObserverIfNeeded];
}

- (void)attachTitlebarObserverIfNeeded {
    NSWindow *window = self.window;
    if (window == nil) {
        return;
    }
    NSButton *closeBtn = [window standardWindowButton:NSWindowCloseButton];
    NSView *titlebarView = closeBtn.superview;
    if (titlebarView == nil || titlebarView == self.observedTitlebarView) {
        return;
    }

    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    if (self.observedTitlebarView != nil) {
        [nc removeObserver:self
                      name:NSViewFrameDidChangeNotification
                    object:self.observedTitlebarView];
    }
    titlebarView.postsFrameChangedNotifications = YES;
    [nc addObserver:self
           selector:@selector(handleLayoutNotification:)
               name:NSViewFrameDidChangeNotification
             object:titlebarView];
    self.observedTitlebarView = titlebarView;
}

- (void)unregisterObservers {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    self.observedTitlebarView = nil;
}

- (void)handleLayoutNotification:(NSNotification *)note {
    (void)note;
    [self applyLayout];
}

- (void)handleWillEnterFullScreen:(NSNotification *)note {
    (void)note;
    [self restoreOriginalLayout];
}

- (void)handleDidExitFullScreen:(NSNotification *)note {
    (void)note;
    [self applyLayout];
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf applyLayout];
    });
}

- (void)handleWillClose:(NSNotification *)note {
    (void)note;
    [self unregisterObservers];
}

- (void)captureOriginalGeometryIfNeededWithClose:(NSButton *)closeBtn
                                             min:(NSButton *)minBtn
                                            zoom:(NSButton *)zoomBtn {
    if (self.hasOrigGeometry) {
        return;
    }
    NSSize boundsSize = closeBtn.bounds.size;
    if (boundsSize.width <= 0.0 || boundsSize.height <= 0.0) {
        return;
    }

    self.origBoundsSize = boundsSize;
    self.origCloseFrame = closeBtn.frame;
    self.origMinFrame = minBtn.frame;
    self.origZoomFrame = zoomBtn.frame;
    // Pre-Liquid-Glass compatibility buttons have 14x16pt bounds with a centered
    // 12x12pt visual circle; native macOS 26+ buttons have 14x14pt bounds.
    self.nativeVisualDiameter = (boundsSize.height > boundsSize.width + 0.5)
        ? 12.0
        : boundsSize.width;
    self.hasOrigGeometry = YES;
}

- (void)updateGroupHoverTrackingAreaForThemeFrame:(NSView *)themeFrame
                                     titlebarView:(NSView *)titlebarView
                                            close:(NSButton *)closeBtn
                                              min:(NSButton *)minBtn
                                             zoom:(NSButton *)zoomBtn {
    if (themeFrame == nil || titlebarView == nil) {
        return;
    }

    NSRect unionInTitlebar = NSUnionRect(NSUnionRect(closeBtn.frame, minBtn.frame), zoomBtn.frame);
    NSRect unionInThemeFrame = [themeFrame convertRect:unionInTitlebar fromView:titlebarView];

    BOOL hasValidCustomArea = NO;
    NSMutableArray<NSTrackingArea *> *staleAreas = nil;
    for (NSTrackingArea *area in themeFrame.trackingAreas) {
        if (area == self.customGroupTrackingArea) {
            if (NSEqualRects(area.rect, unionInThemeFrame)) {
                hasValidCustomArea = YES;
            } else {
                if (staleAreas == nil) staleAreas = [NSMutableArray array];
                [staleAreas addObject:area];
            }
            continue;
        }
        BOOL isThemeFrameHoverArea =
            (area.owner == themeFrame) &&
            (area.userInfo == nil) &&
            ((area.options & NSTrackingMouseEnteredAndExited) != 0) &&
            ((area.options & NSTrackingActiveAlways) != 0) &&
            (area.rect.size.width > 0.0 && area.rect.size.width < 120.0) &&
            (area.rect.size.height > 0.0 && area.rect.size.height < 48.0);
        if (isThemeFrameHoverArea) {
            if (staleAreas == nil) staleAreas = [NSMutableArray array];
            [staleAreas addObject:area];
        }
    }

    for (NSTrackingArea *area in staleAreas) {
        [themeFrame removeTrackingArea:area];
    }

    if (hasValidCustomArea) {
        return;
    }

    NSTrackingArea *updated = [[NSTrackingArea alloc]
        initWithRect:unionInThemeFrame
             options:(NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways)
               owner:themeFrame
            userInfo:nil];
    [themeFrame addTrackingArea:updated];
    self.customGroupTrackingArea = updated;
}

- (void)restoreOriginalLayout {
    NSWindow *window = self.window;
    if (window == nil || !self.hasOrigGeometry || self.isApplying) {
        return;
    }
    if (self.nativeVisualDiameter >= kPiNTargetTrafficLightDiameter - 0.1) {
        return;
    }

    NSButton *closeBtn = [window standardWindowButton:NSWindowCloseButton];
    NSButton *minBtn = [window standardWindowButton:NSWindowMiniaturizeButton];
    NSButton *zoomBtn = [window standardWindowButton:NSWindowZoomButton];
    if (closeBtn == nil || minBtn == nil || zoomBtn == nil) {
        return;
    }

    self.isApplying = YES;
    [closeBtn setFrame:self.origCloseFrame];
    [closeBtn setBoundsSize:self.origBoundsSize];
    [minBtn setFrame:self.origMinFrame];
    [minBtn setBoundsSize:self.origBoundsSize];
    [zoomBtn setFrame:self.origZoomFrame];
    [zoomBtn setBoundsSize:self.origBoundsSize];
    NSView *themeFrame = window.contentView.superview;
    if (themeFrame != nil && self.customGroupTrackingArea != nil) {
        [themeFrame removeTrackingArea:self.customGroupTrackingArea];
        self.customGroupTrackingArea = nil;
    }
    self.isApplying = NO;
}

- (void)applyLayout {
    NSWindow *window = self.window;
    if (window == nil || self.isApplying) {
        return;
    }
    if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
        return;
    }

    NSButton *closeBtn = [window standardWindowButton:NSWindowCloseButton];
    NSButton *minBtn = [window standardWindowButton:NSWindowMiniaturizeButton];
    NSButton *zoomBtn = [window standardWindowButton:NSWindowZoomButton];
    if (closeBtn == nil || minBtn == nil || zoomBtn == nil) {
        return;
    }

    NSView *titlebarView = closeBtn.superview;
    if (titlebarView == nil) {
        return;
    }

    [self attachTitlebarObserverIfNeeded];
    [self captureOriginalGeometryIfNeededWithClose:closeBtn min:minBtn zoom:zoomBtn];
    if (!self.hasOrigGeometry) {
        return;
    }

    if (self.nativeVisualDiameter <= 0.0 ||
        self.nativeVisualDiameter >= kPiNTargetTrafficLightDiameter - 0.1) {
        return;
    }

    CGFloat scale = kPiNTargetTrafficLightDiameter / self.nativeVisualDiameter;
    NSSize scaledFrameSize = NSMakeSize(
        self.origBoundsSize.width * scale,
        self.origBoundsSize.height * scale
    );

    CGFloat titlebarHeight = titlebarView.bounds.size.height;
    if (titlebarHeight <= 0.0) {
        return;
    }
    CGFloat centerY = titlebarView.isFlipped
        ? kPiNTrafficLightCenterYFromTop
        : (titlebarHeight - kPiNTrafficLightCenterYFromTop);
    CGFloat frameY = centerY - scaledFrameSize.height * 0.5;
    if (frameY + scaledFrameSize.height > titlebarHeight) {
        frameY = titlebarHeight - scaledFrameSize.height;
    }
    if (frameY < 0.0) {
        frameY = 0.0;
    }

    CGFloat firstCenterX = kPiNTrafficLightLeftMargin + kPiNTargetTrafficLightDiameter * 0.5;
    NSButton *buttons[3] = { closeBtn, minBtn, zoomBtn };

    self.isApplying = YES;
    for (int i = 0; i < 3; i++) {
        NSButton *btn = buttons[i];
        CGFloat centerX = firstCenterX + kPiNTrafficLightPitch * i;
        CGFloat frameX = centerX - scaledFrameSize.width * 0.5;
        NSRect targetFrame = NSMakeRect(frameX, frameY, scaledFrameSize.width, scaledFrameSize.height);
        [btn setFrame:targetFrame];
        [btn setBoundsSize:self.origBoundsSize];
    }

    [zoomBtn updateTrackingAreas];
    NSView *themeFrame = window.contentView.superview;
    if (themeFrame != nil) {
        [themeFrame updateTrackingAreas];
        [self updateGroupHoverTrackingAreaForThemeFrame:themeFrame
                                           titlebarView:titlebarView
                                                  close:closeBtn
                                                    min:minBtn
                                                   zoom:zoomBtn];
    }
    self.isApplying = NO;
}

@end

static void pi_n_apply_macos_traffic_lights_on_main(NSWindow *window) {
    if (window == nil || ![window isKindOfClass:[NSWindow class]]) {
        return;
    }
    PiNTrafficLightController *controller =
        objc_getAssociatedObject(window, &kPiNTrafficLightControllerKey);
    if (controller == nil) {
        controller = [[PiNTrafficLightController alloc] initWithWindow:window];
        objc_setAssociatedObject(
            window,
            &kPiNTrafficLightControllerKey,
            controller,
            OBJC_ASSOCIATION_RETAIN_NONATOMIC
        );
    }
    [controller applyLayout];
    __weak PiNTrafficLightController *weakController = controller;
    dispatch_async(dispatch_get_main_queue(), ^{
        [weakController applyLayout];
    });
}

void pi_n_macos_configure_traffic_lights(void *ns_window_ptr) {
    if (ns_window_ptr == NULL) {
        return;
    }
    NSWindow *window = (__bridge NSWindow *)ns_window_ptr;
    if ([NSThread isMainThread]) {
        pi_n_apply_macos_traffic_lights_on_main(window);
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            pi_n_apply_macos_traffic_lights_on_main(window);
        });
    }
}

bool pi_n_macos_is_main_thread(void) {
    return [NSThread isMainThread] ? true : false;
}

// Returns 1 for Simplified Chinese, 2 for Traditional Chinese, 0 otherwise,
// following macOS System Settings -> Language & Region preferred languages.
int pi_n_macos_preferred_menu_language(void) {
    @autoreleasepool {
        NSArray<NSString *> *languages = [NSLocale preferredLanguages];
        if (languages == nil || languages.count == 0) {
            return 0;
        }
        NSString *primary = [languages.firstObject lowercaseString];
        if ([primary hasPrefix:@"zh"]) {
            if ([primary containsString:@"hant"]) {
                return 2;
            }
            if ([primary containsString:@"hans"]) {
                return 1;
            }
            if ([primary containsString:@"-tw"] ||
                [primary containsString:@"_tw"] ||
                [primary containsString:@"-hk"] ||
                [primary containsString:@"_hk"] ||
                [primary containsString:@"-mo"] ||
                [primary containsString:@"_mo"]) {
                return 2;
            }
            return 1;
        }
        return 0;
    }
}

typedef void (*PiNPathPanelCallback)(void *context, const char *path_utf8);

static NSWindow *pi_n_resolve_host_window(NSWindow *preferred) {
    NSWindow *candidate = preferred;
    if (candidate != nil &&
        [candidate isKindOfClass:[NSWindow class]] &&
        candidate.isVisible &&
        !candidate.isMiniaturized &&
        candidate.attachedSheet == nil) {
        return candidate;
    }
    candidate = [NSApp keyWindow];
    if (candidate != nil &&
        candidate.isVisible &&
        !candidate.isMiniaturized &&
        candidate.attachedSheet == nil) {
        return candidate;
    }
    candidate = [NSApp mainWindow];
    if (candidate != nil &&
        candidate.isVisible &&
        !candidate.isMiniaturized &&
        candidate.attachedSheet == nil) {
        return candidate;
    }
    return nil;
}

static void pi_n_run_open_panel_as_sheet(
    id self,
    SEL _cmd,
    WKWebView *webView,
    WKOpenPanelParameters *parameters,
    WKFrameInfo *frame,
    void (^completionHandler)(NSArray<NSURL *> * _Nullable)
) {
    (void)self;
    (void)_cmd;
    (void)frame;
    if (completionHandler == nil) {
        return;
    }
    @autoreleasepool {
        __block BOOL completed = NO;
        void (^completeOnce)(NSArray<NSURL *> * _Nullable) = ^(NSArray<NSURL *> * _Nullable urls) {
            if (completed) {
                return;
            }
            completed = YES;
            completionHandler(urls);
        };
        @try {
            NSOpenPanel *panel = [NSOpenPanel openPanel];
            if (panel == nil) {
                completeOnce(nil);
                return;
            }
            panel.canChooseFiles = YES;
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
            panel.canChooseDirectories = parameters.allowsDirectories;

            NSWindow *hostWindow = pi_n_resolve_host_window(webView.window);
            if (hostWindow != nil) {
                [panel beginSheetModalForWindow:hostWindow
                              completionHandler:^(NSModalResponse response) {
                    completeOnce(response == NSModalResponseOK ? panel.URLs : nil);
                }];
            } else if ([panel runModal] == NSModalResponseOK) {
                completeOnce(panel.URLs);
            } else {
                completeOnce(nil);
            }
        } @catch (NSException *exception) {
            fprintf(
                stderr,
                "[Pi^n-desktop] macOS WebView open panel exception: %s\n",
                exception.reason ? exception.reason.UTF8String : "unknown"
            );
            completeOnce(nil);
        }
    }
}

static void pi_n_patch_webview_open_panel_on_main(WKWebView *webView) {
    if (webView == nil || ![webView isKindOfClass:[WKWebView class]]) {
        return;
    }
    id<WKUIDelegate> delegate = webView.UIDelegate;
    if (delegate == nil) {
        return;
    }
    Class delegateClass = object_getClass(delegate);
    if (delegateClass == Nil) {
        return;
    }
    static NSMutableSet<Class> *patchedClasses = nil;
    if (patchedClasses == nil) {
        patchedClasses = [NSMutableSet set];
    }
    if ([patchedClasses containsObject:delegateClass]) {
        return;
    }
    SEL sel = @selector(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:);
    Method method = class_getInstanceMethod(delegateClass, sel);
    if (method != NULL) {
        class_replaceMethod(
            delegateClass,
            sel,
            (IMP)pi_n_run_open_panel_as_sheet,
            method_getTypeEncoding(method)
        );
        [patchedClasses addObject:delegateClass];
    }
}

void pi_n_macos_configure_webview_open_panel(void *wk_webview_ptr) {
    if (wk_webview_ptr == NULL) {
        return;
    }
    WKWebView *webView = (__bridge WKWebView *)wk_webview_ptr;
    if ([NSThread isMainThread]) {
        pi_n_patch_webview_open_panel_on_main(webView);
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            pi_n_patch_webview_open_panel_on_main(webView);
        });
    }
}

static void pi_n_invoke_path_callback(
    PiNPathPanelCallback callback,
    void *context,
    NSURL *url
) {
    if (callback == NULL) {
        return;
    }
    NSString *selectedPath = url.path;
    if (selectedPath != nil && selectedPath.length > 0) {
        callback(context, [selectedPath UTF8String]);
    } else {
        callback(context, NULL);
    }
}

static void pi_n_begin_save_image_panel_on_main(
    NSWindow *preferredWindow,
    NSString *defaultName,
    NSString *defaultDir,
    void *context,
    PiNPathPanelCallback callback
) {
    @autoreleasepool {
        __block BOOL completed = NO;
        void (^completeOnce)(NSURL * _Nullable) = ^(NSURL * _Nullable url) {
            if (completed) {
                return;
            }
            completed = YES;
            pi_n_invoke_path_callback(callback, context, url);
        };
        @try {
            NSSavePanel *panel = [NSSavePanel savePanel];
            if (panel == nil) {
                completeOnce(nil);
                return;
            }
            panel.canCreateDirectories = YES;
            if (defaultName != nil && defaultName.length > 0) {
                panel.nameFieldStringValue = defaultName;
            }
            if (defaultDir != nil && defaultDir.length > 0) {
                BOOL isDir = NO;
                if ([[NSFileManager defaultManager] fileExistsAtPath:defaultDir isDirectory:&isDir] && isDir) {
                    panel.directoryURL = [NSURL fileURLWithPath:defaultDir isDirectory:YES];
                }
            }
            NSWindow *hostWindow = pi_n_resolve_host_window(preferredWindow);
            if (hostWindow != nil) {
                [panel beginSheetModalForWindow:hostWindow
                              completionHandler:^(NSModalResponse response) {
                    completeOnce(response == NSModalResponseOK ? panel.URL : nil);
                }];
            } else {
                NSModalResponse response = [panel runModal];
                completeOnce(response == NSModalResponseOK ? panel.URL : nil);
            }
        } @catch (NSException *exception) {
            fprintf(
                stderr,
                "[Pi^n-desktop] macOS save panel exception: %s\n",
                exception.reason ? exception.reason.UTF8String : "unknown"
            );
            completeOnce(nil);
        }
    }
}

void pi_n_macos_begin_save_image_panel(
    void *ns_window_ptr,
    const char *default_name,
    const char *default_dir,
    void *context,
    PiNPathPanelCallback callback
) {
    if (callback == NULL) {
        return;
    }
    @autoreleasepool {
        NSWindow *preferred = ns_window_ptr != NULL ? (__bridge NSWindow *)ns_window_ptr : nil;
        NSString *name = default_name != NULL ? [NSString stringWithUTF8String:default_name] : nil;
        NSString *dir = default_dir != NULL ? [NSString stringWithUTF8String:default_dir] : nil;
        if ([NSThread isMainThread]) {
            pi_n_begin_save_image_panel_on_main(preferred, name, dir, context, callback);
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                pi_n_begin_save_image_panel_on_main(preferred, name, dir, context, callback);
            });
        }
    }
}

static void pi_n_begin_pick_folder_panel_on_main(
    NSWindow *preferredWindow,
    NSString *prompt,
    void *context,
    PiNPathPanelCallback callback
) {
    @autoreleasepool {
        __block BOOL completed = NO;
        void (^completeOnce)(NSURL * _Nullable) = ^(NSURL * _Nullable url) {
            if (completed) {
                return;
            }
            completed = YES;
            pi_n_invoke_path_callback(callback, context, url);
        };
        @try {
            NSOpenPanel *panel = [NSOpenPanel openPanel];
            if (panel == nil) {
                completeOnce(nil);
                return;
            }
            panel.canChooseFiles = NO;
            panel.canChooseDirectories = YES;
            panel.allowsMultipleSelection = NO;
            panel.canCreateDirectories = YES;
            if (prompt != nil && prompt.length > 0) {
                panel.message = prompt;
            }
            NSWindow *hostWindow = pi_n_resolve_host_window(preferredWindow);
            if (hostWindow != nil) {
                [panel beginSheetModalForWindow:hostWindow
                              completionHandler:^(NSModalResponse response) {
                    completeOnce(response == NSModalResponseOK ? panel.URL : nil);
                }];
            } else {
                NSModalResponse response = [panel runModal];
                completeOnce(response == NSModalResponseOK ? panel.URL : nil);
            }
        } @catch (NSException *exception) {
            fprintf(
                stderr,
                "[Pi^n-desktop] macOS folder picker exception: %s\n",
                exception.reason ? exception.reason.UTF8String : "unknown"
            );
            completeOnce(nil);
        }
    }
}

void pi_n_macos_begin_pick_folder_panel(
    void *ns_window_ptr,
    const char *prompt,
    void *context,
    PiNPathPanelCallback callback
) {
    if (callback == NULL) {
        return;
    }
    @autoreleasepool {
        NSWindow *preferred = ns_window_ptr != NULL ? (__bridge NSWindow *)ns_window_ptr : nil;
        NSString *promptStr = prompt != NULL ? [NSString stringWithUTF8String:prompt] : nil;
        if ([NSThread isMainThread]) {
            pi_n_begin_pick_folder_panel_on_main(preferred, promptStr, context, callback);
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                pi_n_begin_pick_folder_panel_on_main(preferred, promptStr, context, callback);
            });
        }
    }
}
