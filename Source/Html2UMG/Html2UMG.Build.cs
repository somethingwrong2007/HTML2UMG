// Copyright (c) 2026 FPVSkyline. MIT License.

using UnrealBuildTool;

public class Html2UMG : ModuleRules
{
	public Html2UMG(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine",
			}
		);

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				"Slate",
				"SlateCore",
				"UMG",
				"UMGEditor",
				"UnrealEd",
				"EditorFramework",
				"EditorSubsystem",
				"EditorStyle",
				"ToolMenus",
				"MainFrame",
				"DesktopPlatform",
				"Projects",
				"Json",
				"JsonUtilities",
				"AssetTools",
				"AssetRegistry",
				"ImageCore",
				"ImageWrapper",
				"RenderCore",
				"RHI",
				"ApplicationCore",
				"BlueprintGraph",
				"Kismet",
				"KismetCompiler",
				"PropertyEditor",
				"ContentBrowser",
				"DeveloperSettings",
			}
		);
	}
}
