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
				// Runtime half of the plugin (H2URelativeBox): the importer resolves its classes by
				// name, but linking against it keeps the module loaded and its UPROPERTYs usable.
				"Html2UMGRuntime",
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
