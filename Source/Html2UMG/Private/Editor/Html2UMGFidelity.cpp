// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/Html2UMGFidelity.h"

#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetBlueprintGeneratedClass.h"
#include "Components/PanelWidget.h"
#include "Components/Widget.h"
#include "Widgets/SWidget.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Containers/ArrayView.h"
#include "Editor.h"
#include "Engine/Texture.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "Html2UMGLog.h"
#include "ImageUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/App.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Rendering/SlateRenderer.h"
#include "HAL/IConsoleManager.h"
#include "Importer/Html2UMGImporter.h"
#include "Misc/CString.h"
#include "RenderingThread.h"
#include "Slate/WidgetRenderer.h"
#include "TextureResource.h"
#include "UnrealClient.h"
#include "UObject/SoftObjectPath.h"
#include "WidgetBlueprint.h"

namespace
{
	/** Render targets and PNG rows both blow up beyond this; keep the request sane. */
	constexpr int32 MaxRenderDimension = 8192;

	/** Diagnostics for the geometry dump: how many widgets were reachable and actually measured. */
	int32 GGeometryWidgetCount = 0;
	int32 GGeometryWithSlateCount = 0;
	int32 GGeometryWithSizeCount = 0;

	/**
	 * Records the layout Slate actually produced for Widget and its descendants.
	 * Absolute position/size are in render-target pixels because the offscreen renderer's
	 * origin is the top-left of the render target.
	 */
	void WalkWidgetGeometry(UWidget* Widget, UWidget* Parent, TArray<TSharedPtr<FJsonValue>>& Out, int32 Depth)
	{
		if (Widget == nullptr || Depth > 128)
		{
			return;
		}

		// Geometry has to come from the paint pass, not from UWidget::GetCachedGeometry():
		// SWidget::GetCachedGeometry() returns PersistentState.DesktopGeometry, which only exists
		// when a real desktop transform is in play and is therefore zero for an offscreen
		// FWidgetRenderer draw. Paint stores the arrange result in PersistentState.AllottedGeometry,
		// and that pass did run - it produced the png.
		++GGeometryWidgetCount;

		FGeometry Geometry;
		if (const TSharedPtr<SWidget> SlateWidget = Widget->GetCachedWidget())
		{
			++GGeometryWithSlateCount;
			Geometry = SlateWidget->GetPersistentState().AllottedGeometry;
		}
		if (!Geometry.GetAbsoluteSize().IsNearlyZero())
		{
			++GGeometryWithSizeCount;
		}
		if (Geometry.GetAbsoluteSize().IsNearlyZero())
		{
			Geometry = Widget->GetCachedGeometry();
		}
		const FVector2D Position = Geometry.GetAbsolutePosition();
		const FVector2D Size = Geometry.GetAbsoluteSize();

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Widget->GetName());
		Entry->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
		if (Parent != nullptr)
		{
			Entry->SetStringField(TEXT("parent"), Parent->GetName());
		}
		Entry->SetNumberField(TEXT("x"), Position.X);
		Entry->SetNumberField(TEXT("y"), Position.Y);
		Entry->SetNumberField(TEXT("w"), Size.X);
		Entry->SetNumberField(TEXT("h"), Size.Y);
		// A widget that never got painted has a zero-area cached geometry; callers must not
		// read that as "laid out at the origin".
		Entry->SetBoolField(TEXT("painted"), Size.X > 0.0 || Size.Y > 0.0);
		Out.Add(MakeShared<FJsonValueObject>(Entry));

		if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			const int32 ChildCount = Panel->GetChildrenCount();
			for (int32 Index = 0; Index < ChildCount; ++Index)
			{
				WalkWidgetGeometry(Panel->GetChildAt(Index), Widget, Out, Depth + 1);
			}
			return;
		}

		if (UUserWidget* Nested = Cast<UUserWidget>(Widget))
		{
			WalkWidgetGeometry(Nested->GetRootWidget(), Widget, Out, Depth + 1);
		}
	}

	FString NormalizeObjectPath(const FString& InPath)
	{
		FString Path = InPath;
		Path.TrimStartAndEndInline();
		Path.TrimQuotesInline();

		if (Path.IsEmpty())
		{
			return FString();
		}

		// "/Game/UI/WBP_Foo" -> "/Game/UI/WBP_Foo.WBP_Foo" so LoadObject can resolve it.
		if (Path.StartsWith(TEXT("/")) && !Path.Contains(TEXT(".")))
		{
			Path += TEXT(".") + FPaths::GetCleanFilename(Path);
		}
		return Path;
	}
}

bool FHtml2UMGFidelity::RenderWidgetToFolder(const FString& BlueprintPath, FVector2D Size, const FString& OutDirectory, FString& OutPngFile, FString& OutError)
{
	OutPngFile.Reset();

	FString BaseName = FPaths::GetCleanFilename(NormalizeObjectPath(BlueprintPath));
	BaseName.ReplaceInline(TEXT("."), TEXT("_"));
	if (BaseName.IsEmpty())
	{
		BaseName = TEXT("widget");
	}

	const FString Directory = OutDirectory.IsEmpty()
		? FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Html2UMG"), TEXT("Fidelity"))
		: OutDirectory;
	OutPngFile = FPaths::Combine(Directory, BaseName + TEXT(".png"));

	return RenderWidgetToFile(BlueprintPath, Size, OutPngFile, OutError);
}

bool FHtml2UMGFidelity::RenderWidgetToFile(const FString& BlueprintPath, FVector2D Size, const FString& OutPng, FString& OutError, const FString& OutGeometryJson)
{
	OutError.Reset();

	if (BlueprintPath.IsEmpty())
	{
		OutError = TEXT("No widget blueprint path was given.");
		return false;
	}
	if (OutPng.IsEmpty())
	{
		OutError = TEXT("No output png path was given.");
		return false;
	}
	if (!FApp::CanEverRender())
	{
		OutError = TEXT("Rendering is disabled for this process, so the widget cannot be rendered to a png. ")
			TEXT("FApp::CanEverRender() is false when -nullrhi is passed or when running inside a -run= commandlet. ")
			TEXT("A -run= commandlet never initialises the Slate renderer, so render through the editor instead: ")
			TEXT("-ExecCmds=\"Html2UMG.RenderPng <blueprint> <out.png> <W>x<H>, QUIT_EDITOR\" -RenderOffscreen.");
		return false;
	}

	// FWidgetRenderer::DrawWidget calls FSlateApplication::Get().GetRenderer(); the engine only
	// initialises that renderer outside of commandlets (LaunchEngineLoop.cpp), so verify it here
	// instead of dereferencing a null renderer deep inside Slate.
	if (!FSlateApplication::IsInitialized())
	{
		OutError = TEXT("No Slate application is running, so the widget cannot be rendered. ")
			TEXT("Run the editor (not -run=) with -RenderOffscreen and trigger the render through ")
			TEXT("-ExecCmds=\"Html2UMG.RenderPng <blueprint> <out.png> <W>x<H>, QUIT_EDITOR\".");
		return false;
	}
	if (FSlateApplication::Get().GetRenderer() == nullptr)
	{
		OutError = TEXT("The Slate renderer is not initialised in this process (the engine skips it for ")
			TEXT("-run= commandlets), so UMG cannot be drawn. Use the editor process with -RenderOffscreen ")
			TEXT("and -ExecCmds=\"Html2UMG.RenderPng <blueprint> <out.png> <W>x<H>, QUIT_EDITOR\" instead.");
		return false;
	}

	const int32 Width = FMath::Clamp(FMath::RoundToInt32(Size.X), 1, MaxRenderDimension);
	const int32 Height = FMath::Clamp(FMath::RoundToInt32(Size.Y), 1, MaxRenderDimension);
	const FVector2D DrawSize(static_cast<float>(Width), static_cast<float>(Height));

	// 1) Load the widget blueprint asset.
	const FString ObjectPath = NormalizeObjectPath(BlueprintPath);
	UWidgetBlueprint* WidgetBlueprint = Cast<UWidgetBlueprint>(FSoftObjectPath(ObjectPath).TryLoad());
	if (WidgetBlueprint == nullptr)
	{
		// Fall back to a plain LoadObject: covers blueprints whose object name differs
		// from the package name and sub-object paths.
		WidgetBlueprint = LoadObject<UWidgetBlueprint>(nullptr, *BlueprintPath);
	}
	if (WidgetBlueprint == nullptr)
	{
		OutError = FString::Printf(TEXT("No Widget Blueprint found at '%s'."), *BlueprintPath);
		return false;
	}

	// 2) Generated class - compile when the asset was never compiled.
	UClass* WidgetClass = WidgetBlueprint->GeneratedClass;
	if (WidgetClass == nullptr)
	{
		FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);
		WidgetClass = WidgetBlueprint->GeneratedClass;
	}
	if (WidgetClass == nullptr || !WidgetClass->IsChildOf(UUserWidget::StaticClass()))
	{
		OutError = FString::Printf(TEXT("'%s' has no usable generated class (compile the blueprint and try again)."), *BlueprintPath);
		return false;
	}

	// 3) The editor world is the only world available while no PIE session runs.
	UWorld* World = nullptr;
	if (GEditor != nullptr)
	{
		World = GEditor->GetEditorWorldContext().World();
	}
	if (World == nullptr)
	{
		OutError = TEXT("No editor world is available to host the widget.");
		return false;
	}

	UUserWidget* UserWidget = CreateWidget<UUserWidget>(World, WidgetClass, FName(TEXT("Html2UMGFidelityWidget")));
	if (UserWidget == nullptr)
	{
		OutError = FString::Printf(TEXT("Could not create an instance of '%s'."), *WidgetClass->GetName());
		return false;
	}

	// 4) Draw it offscreen.
	// Gamma correction must be ON: the reference this gets compared against is a browser
	// screenshot, which is sRGB-encoded. Writing linear values out would shift every pixel
	// by a constant factor and make any pixel diff meaningless.
	UTextureRenderTarget2D* RenderTarget = FWidgetRenderer::CreateTargetFor(DrawSize, TF_Nearest, /*bUseGammaCorrection=*/ true);
	if (RenderTarget == nullptr)
	{
		OutError = TEXT("Could not create a render target for the widget.");
		return false;
	}

	FWidgetRenderer WidgetRenderer(/*bUseGammaCorrection=*/ true, /*bInClearTarget=*/ true);

	// Keep the Slate tree alive for the rest of the function on purpose.
	// TakeWidget() hands back the only STRONG reference: UWidget::MyWidget is a TWeakPtr, so once
	// this local TSharedRef goes out of scope the whole tree is destroyed and every
	// UWidget::GetCachedWidget() returns null. That is why an earlier version of the geometry dump
	// reported 67 widgets but measured zero of them.
	const TSharedRef<SWidget> SlateWidget = UserWidget->TakeWidget();
	WidgetRenderer.DrawWidget(RenderTarget, SlateWidget, DrawSize, /*DeltaTime=*/ 0.0f, /*bDeferRenderTargetUpdate=*/ false);
	FlushRenderingCommands();

	// 4b) Optionally dump the geometry Slate just computed for every widget. This is the only
	// honest source of "where did UMG actually put this": the importer's slot values are inputs,
	// but auto-sized text, container padding and desired-size rounding only exist after layout.
	if (!OutGeometryJson.IsEmpty())
	{
		TArray<TSharedPtr<FJsonValue>> Entries;
		if (UWidget* RootWidget = UserWidget->GetRootWidget())
		{
			WalkWidgetGeometry(RootWidget, nullptr, Entries, 0);
		}

		TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
		RootObject->SetStringField(TEXT("blueprint"), BlueprintPath);
		RootObject->SetNumberField(TEXT("width"), Width);
		RootObject->SetNumberField(TEXT("height"), Height);
		RootObject->SetArrayField(TEXT("widgets"), Entries);

		FString Serialized;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
		if (FJsonSerializer::Serialize(RootObject.ToSharedRef(), Writer))
		{
			const FString GeometryFile = FPaths::ConvertRelativePathToFull(OutGeometryJson);
			const FString GeometryDir = FPaths::GetPath(GeometryFile);
			if (!GeometryDir.IsEmpty())
			{
				IFileManager::Get().MakeDirectory(*GeometryDir, true);
			}
			FFileHelper::SaveStringToFile(Serialized, *GeometryFile);
			UE_LOG(LogHtml2UMG, Log,
				TEXT("Html2UMG fidelity: geometry of %d widget(s) -> '%s' (slate=%d, measured=%d)."),
				Entries.Num(), *GeometryFile, GGeometryWithSlateCount, GGeometryWithSizeCount);
		}
	}

	// 5) Read back the pixels.
	FTextureRenderTargetResource* RenderTargetResource = RenderTarget->GameThread_GetRenderTargetResource();
	if (RenderTargetResource == nullptr)
	{
		UserWidget->ReleaseSlateResources(true);
		OutError = TEXT("The render target has no resource to read pixels from.");
		return false;
	}

	TArray<FColor> Pixels;
	const FReadSurfaceDataFlags ReadFlags;
	if (!RenderTargetResource->ReadPixels(Pixels, ReadFlags, FIntRect(0, 0, Width, Height)) || Pixels.Num() < Width * Height)
	{
		UserWidget->ReleaseSlateResources(true);
		OutError = TEXT("Reading the rendered pixels back failed.");
		return false;
	}

	UserWidget->ReleaseSlateResources(true);

	// 5b) Undo the extra sRGB encode carried by the read-back.
	//
	// The render target is created with the slate-recommended colour format and gamma
	// correction on, so the values that come back are display-referred (sRGB-encoded)
	// *on top of* the transfer function the brush colours were already authored with.
	// Measured, not assumed: a brush tint of 0.0021 (linear #070a0f) came back as byte 46,
	// while the same pixel in the browser screenshot is byte 7 - i.e. one redundant encode.
	// Linearising here makes the PNG byte-identical to the browser's own pixel values, so a
	// pixel diff against the reference is meaningful.
	const auto UndoExtraGamma = [](uint8 In)
	{
		const float Normalized = static_cast<float>(In) / 255.0f;
		const float Linear = Normalized <= 0.04045f
			? Normalized / 12.92f
			: FMath::Pow((Normalized + 0.055f) / 1.055f, 2.4f);
		return static_cast<uint8>(FMath::Clamp(FMath::RoundToInt(Linear * 255.0f), 0, 255));
	};

	for (FColor& Pixel : Pixels)
	{
		Pixel.R = UndoExtraGamma(Pixel.R);
		Pixel.G = UndoExtraGamma(Pixel.G);
		Pixel.B = UndoExtraGamma(Pixel.B);
	}

	// 6) Encode and write. FColor is BGRA in memory, which is exactly what the PNG encoder wants.
	TArray64<uint8> PngBytes;
	FImageUtils::PNGCompressImageArray(
		Width,
		Height,
		TArrayView64<const FColor>(Pixels.GetData(), static_cast<int64>(Width) * Height),
		PngBytes);

	if (PngBytes.Num() == 0)
	{
		OutError = TEXT("PNG encoding produced no data.");
		return false;
	}

	const FString OutputFile = FPaths::ConvertRelativePathToFull(OutPng);
	const FString OutputDir = FPaths::GetPath(OutputFile);
	if (!OutputDir.IsEmpty())
	{
		IFileManager::Get().MakeDirectory(*OutputDir, true);
	}

	if (!FFileHelper::SaveArrayToFile(PngBytes, *OutputFile))
	{
		OutError = FString::Printf(TEXT("Could not write the png to '%s'."), *OutputFile);
		return false;
	}

	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG fidelity: rendered '%s' to '%s' (%dx%d)."), *BlueprintPath, *OutputFile, Width, Height);
	return true;
}

namespace
{
	/** "1920x1080" -> FVector2D, falling back to 1920x1080. */
	FVector2D ParseRenderSize(const FString& InText)
	{
		FString Left;
		FString Right;
		if (InText.Split(TEXT("x"), &Left, &Right))
		{
			const double ParsedWidth = FCString::Atod(*Left);
			const double ParsedHeight = FCString::Atod(*Right);
			if (ParsedWidth > 0.0 && ParsedHeight > 0.0)
			{
				return FVector2D(ParsedWidth, ParsedHeight);
			}
		}
		return FVector2D(1920.0, 1080.0);
	}

	/**
	 * Html2UMG.RenderGeometry <blueprint> <out.png> <out-geometry.json> [WxH]
	 *
	 * Renders like Html2UMG.RenderPng but also writes the geometry every widget was laid out
	 * at, so a layout audit can compare UMG rects against the browser's rects numerically
	 * instead of by eye.
	 */
	void RenderGeometryCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 3)
		{
			UE_LOG(LogHtml2UMG, Warning,
				TEXT("Usage: Html2UMG.RenderGeometry <blueprintPath> <out.png> <out-geometry.json> [WxH]"));
			return;
		}

		const FString BlueprintPath = Args[0];
		FString OutPng = Args[1];
		FString OutGeometry = Args[2];
		OutPng.TrimQuotesInline();
		OutGeometry.TrimQuotesInline();
		const FVector2D Size = Args.Num() >= 4 ? ParseRenderSize(Args[3]) : FVector2D(1920.0, 1080.0);

		FString Error;
		if (FHtml2UMGFidelity::RenderWidgetToFile(BlueprintPath, Size, OutPng, Error, OutGeometry))
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.RenderGeometry: SUCCESS -> %s / %s"), *OutPng, *OutGeometry);
		}
		else
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.RenderGeometry: FAILED - %s"), *Error);
		}
	}

	/** Like Html2UMG.ImportAndRender but also dumps geometry, so one editor run proves the layout. */
	void ImportRenderGeometryCommand(const TArray<FString>& Args)
	{
		if (Args.Num() < 4)
		{
			UE_LOG(LogHtml2UMG, Warning,
				TEXT("Usage: Html2UMG.ImportRenderGeometry <layout.json> <blueprintPath> <out.png> <out-geometry.json> [WxH]"));
			return;
		}

		FString JsonFile = Args[0];
		FString OutPng = Args[2];
		FString OutGeometry = Args[3];
		JsonFile.TrimQuotesInline();
		OutPng.TrimQuotesInline();
		OutGeometry.TrimQuotesInline();
		const FString BlueprintPath = Args[1];
		const FVector2D Size = Args.Num() >= 5 ? ParseRenderSize(Args[4]) : FVector2D(1920.0, 1080.0);

		FH2UImportOptions Options;
		Options.BlueprintPath = BlueprintPath;
		Options.bCompile = true;
		Options.bSave = true;

		FH2UImportResult Result;
		const bool bImported = FHtml2UMGImporter::ImportLayoutFile(JsonFile, Options, Result);
		// Say WHY it failed before the one-line summary: a bare "1 error(s)" is not debuggable.
		FHtml2UMGImporter::LogImportMessages(Result);
		UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ImportRenderGeometry: import %s (%d created, %d error(s))"),
			bImported ? TEXT("SUCCESS") : TEXT("FAILED"), Result.WidgetsCreated, Result.ErrorCount());
		if (!bImported)
		{
			return;
		}

		FString Error;
		const FString RenderTarget = Result.BlueprintPath.IsEmpty() ? BlueprintPath : Result.BlueprintPath;
		if (FHtml2UMGFidelity::RenderWidgetToFile(RenderTarget, Size, OutPng, Error, OutGeometry))
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.ImportRenderGeometry: SUCCESS -> %s / %s"), *OutPng, *OutGeometry);
		}
		else
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.ImportRenderGeometry: render FAILED - %s"), *Error);
		}
	}
}

static FAutoConsoleCommand GRenderGeometryCommand(
	TEXT("Html2UMG.RenderGeometry"),
	TEXT("Renders a Widget Blueprint to a PNG and dumps the laid-out geometry of every widget. ")
	TEXT("Usage: Html2UMG.RenderGeometry <blueprintPath> <out.png> <out-geometry.json> [WxH]"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&RenderGeometryCommand));

static FAutoConsoleCommand GImportRenderGeometryCommand(
	TEXT("Html2UMG.ImportRenderGeometry"),
	TEXT("Imports a layout json, renders it and dumps the laid-out geometry. ")
	TEXT("Usage: Html2UMG.ImportRenderGeometry <layout.json> <blueprintPath> <out.png> <out-geometry.json> [WxH]"),
	FConsoleCommandWithArgsDelegate::CreateStatic(&ImportRenderGeometryCommand));
