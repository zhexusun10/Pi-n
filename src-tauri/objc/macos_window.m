#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <stdbool.h>
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
    [self unregisterObservers];
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
    CGFloat centerY = titlebarView.isFlipped
        ? kPiNTrafficLightCenterYFromTop
        : (titlebarHeight - kPiNTrafficLightCenterYFromTop);
    CGFloat frameY = centerY - scaledFrameSize.height * 0.5;
    if (frameY < 0.0) {
        frameY = 0.0;
    }
    if (frameY + scaledFrameSize.height > titlebarHeight) {
        frameY = titlebarHeight - scaledFrameSize.height;
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
