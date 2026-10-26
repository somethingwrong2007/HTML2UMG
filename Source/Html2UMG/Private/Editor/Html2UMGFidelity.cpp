// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/Html2UMGFidelity.h"

#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetBlueprintGeneratedClass.h"
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

bool FHtml2UMGFidelity::RenderWidgetToFile(const FString& BlueprintPath, FVector2D Size, const FString& OutPng, FString& OutError)
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
	{
		const TSharedRef<SWidget> SlateWidget = UserWidget->TakeWidget();
		WidgetRenderer.DrawWidget(RenderTarget, SlateWidget, DrawSize, /*DeltaTime=*/ 0.0f, /*bDeferRenderTargetUpdate=*/ false);
	}
	FlushRenderingCommands();

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
